#pragma once
// A socket peer speaking native-rpc/1 for tests (not a mock of business logic): it frames/deframes, enforces the
// gateway's own transport limits (4 MiB frame, 32 in flight -> close), and lets a test script replies and events.
#include "frame_codec.hpp"
#include "jvalue.hpp"

#include <QLocalServer>
#include <QLocalSocket>
#include <QMutex>
#include <QObject>
#include <QPointer>
#include <QThread>
#include <QTimer>
#include <functional>

namespace agentos::test {

class FakeGateway : public QObject {
  Q_OBJECT
 public:
  /** Return a reply body (object) or an error via {"__error":{code,message}}; missing = do not answer (test answers later). */
  using Handler = std::function<JValue(const JValue& request)>;
  explicit FakeGateway(QString path) : path_(std::move(path)) {}
  ~FakeGateway() override = default;

  // thread-safe accessors
  int requestsSeen() const { QMutexLocker l(&m_); return int(requests_.size()); }
  QVector<JValue> requests() const { QMutexLocker l(&m_); return requests_; }
  int maxOpen() const { QMutexLocker l(&m_); return maxOpen_; }
  int open() const { QMutexLocker l(&m_); return open_; }
  int connections() const { QMutexLocker l(&m_); return connections_; }
  int closedForLimit() const { QMutexLocker l(&m_); return closedForLimit_; }
  void setHandler(Handler h) { QMutexLocker l(&m_); handler_ = std::move(h); }

 public slots:
  void listen() {
    QLocalServer::removeServer(path_);
    server_ = new QLocalServer(this);
    server_->setSocketOptions(QLocalServer::UserAccessOption);
    connect(server_, &QLocalServer::newConnection, this, [this] {
      while (QLocalSocket* s = server_->nextPendingConnection()) {
        {
          QMutexLocker l(&m_);
          connections_++;
          open_ = 0;
        }
        conn_ = s;
        dec_.reset();
        s->setReadBufferSize(paused_ ? 64 * 1024 : 0);
        connect(s, &QLocalSocket::readyRead, this, &FakeGateway::onRead);
        connect(s, &QLocalSocket::disconnected, s, &QObject::deleteLater);
      }
    });
    server_->listen(path_);
  }
  void reply(QString requestId, agentos::JValue body) { send(replyFor(requestId, body)); }
  void replyAllOpen(agentos::JValue body) {
    QVector<JValue> pend;
    {
      QMutexLocker l(&m_);
      pend = unanswered_;
      unanswered_.clear();
      open_ = 0;
    }
    for (const auto& r : pend) sendReply(r, body);
  }
  void sendEvent(QString ws, qint64 seq, QString type, agentos::JValue data) {
    JValue e = JValue::object({{QStringLiteral("workspaceId"), ws}, {QStringLiteral("eventSeq"), double(seq)}, {QStringLiteral("type"), type}, {QStringLiteral("data"), data}});
    send(e.toJsonUtf8());
  }
  void sendRawFrameHeader(quint32 len) {
    QByteArray h(4, 0);
    h[0] = char(len >> 24);
    h[1] = char(len >> 16);
    h[2] = char(len >> 8);
    h[3] = char(len);
    if (conn_) conn_->write(h);
  }
  void sendPayload(QByteArray payload) { send(payload); }
  void dropConnection() {
    if (conn_) conn_->abort();
    QMutexLocker l(&m_);
    unanswered_.clear();
    open_ = 0;
  }
  void pauseReading(bool on) {
    paused_ = on;
    if (conn_) {
      conn_->setReadBufferSize(on ? 64 * 1024 : 0);
      if (!on) QTimer::singleShot(0, this, &FakeGateway::onRead);
    }
  }
  void shutdown() {
    if (conn_) conn_->abort();
    if (server_) server_->close();
  }

 private:
  QString path_;
  QLocalServer* server_ = nullptr;
  QPointer<QLocalSocket> conn_;
  FrameDecoder dec_;
  bool paused_ = false;
  mutable QMutex m_;
  QVector<JValue> requests_, unanswered_;
  int open_ = 0, maxOpen_ = 0, connections_ = 0, closedForLimit_ = 0;
  Handler handler_;

  void send(const QByteArray& payload) {
    if (conn_) conn_->write(encodeFrame(payload));
  }
  QByteArray replyFor(const QString& id, const JValue& body) {
    JValue req;
    {
      QMutexLocker l(&m_);
      for (int i = 0; i < unanswered_.size(); ++i)
        if (unanswered_[i].get(QStringLiteral("requestId")).str() == id) {
          req = unanswered_[i];
          unanswered_.remove(i);
          open_--;
          break;
        }
    }
    return build(req.isMissing() ? JValue::object({{QStringLiteral("requestId"), id}}) : req, body);
  }
  static QByteArray build(const JValue& req, const JValue& body) {
    JValue r = JValue::object();
    r.set(QStringLiteral("requestId"), req.get(QStringLiteral("requestId")));
    r.set(QStringLiteral("workspaceId"), req.get(QStringLiteral("workspaceId")));
    r.set(QStringLiteral("clientEpoch"), req.get(QStringLiteral("clientEpoch")));
    if (body.isObject() && body.has(QStringLiteral("__error"))) {
      r.set(QStringLiteral("status"), 409.0);
      r.set(QStringLiteral("error"), body.get(QStringLiteral("__error")));
    } else {
      r.set(QStringLiteral("status"), 200.0);
      r.set(QStringLiteral("body"), body);
    }
    return r.toJsonUtf8();
  }
  void sendReply(const JValue& req, const JValue& body) { send(build(req, body)); }
  void onRead() {
    if (!conn_ || paused_) return;
    dec_.feed(conn_->readAll());
    for (;;) {
      QByteArray p;
      auto st = dec_.next(&p);
      if (st == FrameDecoder::Status::NeedMore) break;
      if (st == FrameDecoder::Status::TooLarge) {
        QMutexLocker l(&m_);
        closedForLimit_++;
        conn_->abort();
        return;
      }
      JValue req = parseJson(p, nullptr, {64, kMaxFrameBytes});
      Handler h;
      {
        QMutexLocker l(&m_);
        requests_.push_back(req);
        bool dup = false;
        for (const auto& u : unanswered_)
          if (u.get(QStringLiteral("requestId")).str() == req.get(QStringLiteral("requestId")).str()) dup = true;
        if (!dup) {
          unanswered_.push_back(req);
          open_++;
        }
        maxOpen_ = std::max(maxOpen_, open_);
        if (open_ > kMaxInflight) {
          closedForLimit_++;
          conn_->abort();  // the gateway closes a connection over 32 in flight
          return;
        }
        h = handler_;
      }
      if (h) {
        JValue body = h(req);
        if (!body.isMissing()) reply(req.get(QStringLiteral("requestId")).str(), body);
      }
    }
  }
};

/** Runs a FakeGateway on its own thread. */
class GatewayThread {
 public:
  explicit GatewayThread(const QString& path) : gw(new FakeGateway(path)) {
    gw->moveToThread(&thread);
    thread.start();
    QMetaObject::invokeMethod(gw, "listen", Qt::BlockingQueuedConnection);
  }
  ~GatewayThread() {
    QMetaObject::invokeMethod(gw, "shutdown", Qt::BlockingQueuedConnection);
    QMetaObject::invokeMethod(gw, "deleteLater", Qt::QueuedConnection);
    thread.quit();
    thread.wait();
  }
  template <typename F>
  void run(F f) { QMetaObject::invokeMethod(gw, f, Qt::BlockingQueuedConnection); }
  FakeGateway* gw;
  QThread thread;
};

}  // namespace agentos::test
