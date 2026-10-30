#include "rpc_client.hpp"

#include "routes.hpp"

#include <QRegularExpression>
#include <QUuid>

namespace agentos {

static const QSet<QString> kCritical = {QStringLiteral("membership.revoking"), QStringLiteral("membership.revoked"), QStringLiteral("session.locked"),
                                        QStringLiteral("session.ended"), QStringLiteral("workspace.state_changed"), QStringLiteral("event.gap")};
bool RpcEvent::critical() const { return kCritical.contains(type); }

QByteArray RpcCall::encode() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("requestId"), requestId);
  o.set(QStringLiteral("workspaceId"), workspaceId);
  o.set(QStringLiteral("clientEpoch"), double(clientEpoch));
  o.set(QStringLiteral("sessionEpoch"), double(sessionEpoch));
  o.set(QStringLiteral("methodId"), methodId);
  o.set(QStringLiteral("params"), params.isMissing() ? JValue::null() : params);
  o.set(QStringLiteral("body"), body.isMissing() ? JValue::null() : body);
  if (!idempotencyKey.isEmpty()) o.set(QStringLiteral("idempotencyKey"), idempotencyKey);
  return o.toJsonUtf8();
}

static void registerTypes() {
  static bool done = false;
  if (done) return;
  done = true;
  qRegisterMetaType<agentos::RpcCall>("agentos::RpcCall");
  qRegisterMetaType<agentos::RpcReply>("agentos::RpcReply");
  qRegisterMetaType<agentos::RpcEvent>("agentos::RpcEvent");
  qRegisterMetaType<agentos::RpcStats>("agentos::RpcStats");
}

// ------------------------------------------------------------------ worker
RpcWorker::RpcWorker(QString socketPath) : path_(std::move(socketPath)) { registerTypes(); }
RpcWorker::~RpcWorker() = default;

void RpcWorker::setSocketPath(QString path) { path_ = std::move(path); }

void RpcWorker::start() {
  stopped_ = false;
  if (!tick_) {
    tick_ = new QTimer(this);
    tick_->setInterval(250);
    connect(tick_, &QTimer::timeout, this, &RpcWorker::onTick);
    tick_->start();
    retry_ = new QTimer(this);
    retry_->setSingleShot(true);
    connect(retry_, &QTimer::timeout, this, &RpcWorker::connectSocket);
  }
  connectSocket();
}

void RpcWorker::stop() {
  stopped_ = true;
  if (tick_) tick_->stop();
  if (retry_) retry_->stop();
  if (sock_) {
    sock_->disconnect(this);
    sock_->abort();
    sock_->deleteLater();
    sock_ = nullptr;
  }
}

void RpcWorker::connectSocket() {
  if (stopped_) return;
  if (sock_) {
    sock_->disconnect(this);
    sock_->abort();
    sock_->deleteLater();
  }
  sock_ = new QLocalSocket(this);
  sock_->setReadBufferSize(0);
  connect(sock_, &QLocalSocket::connected, this, &RpcWorker::onConnected);
  connect(sock_, &QLocalSocket::disconnected, this, &RpcWorker::onDisconnected);
  connect(sock_, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError) {
    if (sock_ && sock_->state() != QLocalSocket::ConnectedState) onDisconnected();
  });
  connect(sock_, &QLocalSocket::readyRead, this, &RpcWorker::onReadyRead);
  connect(sock_, &QLocalSocket::bytesWritten, this, [this](qint64) { pump(); });
  dec_.reset();
  sock_->connectToServer(path_);
}

void RpcWorker::onConnected() {
  backoffMs_ = 100;
  emit connectionChanged(true);
  // Retry by requestId: everything that was in flight goes out again with the SAME requestId and idempotencyKey.
  for (const QString& id : order_) {
    auto it = inflight_.find(id);
    if (it == inflight_.end()) continue;
    if (it->sent) stats_.resent++;
    sendPending(*it);
  }
  for (auto it = subs_.begin(); it != subs_.end(); ++it) {
    if (!it->active || it->gap) continue;
    RpcCall c;
    c.workspaceId = it.key();
    c.clientEpoch = it->clientEpoch;
    c.sessionEpoch = it->sessionEpoch;
    c.methodId = QStringLiteral("events.subscribe");
    c.params = JValue::object({{QStringLiteral("workspaceId"), it.key()}});
    c.body = JValue::object({{QStringLiteral("cursor"), double(it->cursor)}});
    sendInternal(c);
  }
  pump();
}

void RpcWorker::onDisconnected() {
  if (stopped_) return;
  const bool wasConnected = retry_ && !retry_->isActive();
  for (auto& p : inflight_) p.sent = false;
  if (wasConnected) {
    stats_.reconnects++;
    emit connectionChanged(false);
    retry_->start(backoffMs_);
    backoffMs_ = std::min(2000, backoffMs_ * 2);
  }
  publishStats();
}

void RpcWorker::reconnectNow() {
  backoffMs_ = 100;
  if (retry_) retry_->stop();
  connectSocket();
}

void RpcWorker::abortConnection(const QString& why) {
  stats_.protocolErrors++;
  emit protocolError(why);
  if (sock_) sock_->abort();
}

void RpcWorker::onReadyRead() {
  if (!sock_) return;
  dec_.feed(sock_->readAll());
  for (;;) {
    QByteArray payload;
    auto st = dec_.next(&payload);
    if (st == FrameDecoder::Status::NeedMore) break;
    if (st == FrameDecoder::Status::TooLarge) {
      dec_.reset();
      abortConnection(QStringLiteral("frame larger than 4 MiB from gateway"));
      return;
    }
    handleFrame(payload);
    if (!sock_ || sock_->state() != QLocalSocket::ConnectedState) return;
  }
}

void RpcWorker::handleFrame(const QByteArray& payload) {
  QString err;
  JValue v = parseJson(payload, &err, {64, kMaxFrameBytes});
  if (!err.isEmpty() || !v.isObject()) {
    abortConnection(QStringLiteral("unparseable frame: ") + err);
    return;
  }
  if (v.has(QStringLiteral("eventSeq"))) handleEvent(v);
  else if (v.has(QStringLiteral("requestId"))) handleReply(v);
  else abortConnection(QStringLiteral("frame is neither a response nor an event"));
}

// The real session gateway (V1-D08/M06, m13-native) answers in the shapes of its two sources: a forwarded Host route
// comes back as {status, body:{data:…}} or {status ≥ 400, body:{error:{code,message}}}, and machined's lists are named
// arrays ({workspaces:[…]}, {members:[…]}). The Shell's reply model is one shape: errors in errorCode, lists in
// body.items. Normalise here, once, for every caller.
static void normalizeReply(RpcReply& r) {
  if (r.errorCode.isEmpty() && r.status.isNumber() && r.status.toNumber() >= 400) {
    const JValue& e = r.body.get(QStringLiteral("error"));
    r.errorCode = e.isObject() ? e.get(QStringLiteral("code")).stringOr(QStringLiteral("INTERNAL")) : QStringLiteral("HTTP_") + QString::number(int(r.status.toNumber()));
    r.errorMessage = e.isObject() ? e.get(QStringLiteral("message")).stringOr(r.errorCode) : r.errorCode;
    return;
  }
  if (r.body.isObject() && r.body.has(QStringLiteral("data")) && !r.body.has(QStringLiteral("items"))) {
    const JValue data = r.body.get(QStringLiteral("data"));
    JValue out = data.isArray() ? JValue::object({{QStringLiteral("items"), data}}) : data;
    if (out.isObject())
      for (const QString& k : r.body.keys())
        if (k != QLatin1String("data") && !out.has(k)) out.set(k, r.body.get(k));
    r.body = out.isObject() ? out : r.body;
  } else if (r.body.isArray()) {
    r.body = JValue::object({{QStringLiteral("items"), r.body}});
  }
  if (!r.body.isObject() || r.body.has(QStringLiteral("items"))) return;
  for (const char* k : {"workspaces", "members", "sets", "backups", "runs", "apps"}) {
    const JValue& l = r.body.get(QString::fromLatin1(k));
    if (l.isArray()) {
      r.body.set(QStringLiteral("items"), l);
      break;
    }
  }
  if (!r.body.has(QStringLiteral("userName")) && r.body.get(QStringLiteral("loginName")).isString()) r.body.set(QStringLiteral("userName"), r.body.get(QStringLiteral("loginName")));
  if (!r.body.has(QStringLiteral("cursor")) && r.body.get(QStringLiteral("eventCursor")).isNumber()) r.body.set(QStringLiteral("cursor"), r.body.get(QStringLiteral("eventCursor")));
}

void RpcWorker::handleReply(const JValue& v) {
  const QString id = v.get(QStringLiteral("requestId")).stringOr(QString());
  auto it = inflight_.find(id);
  if (it == inflight_.end()) {
    stats_.droppedReplies++;  // duplicate answer to a status query, or a request we no longer track
    return;
  }
  RpcReply r;
  r.requestId = id;
  r.workspaceId = v.get(QStringLiteral("workspaceId")).stringOr(QString());
  r.clientEpoch = qint64(v.get(QStringLiteral("clientEpoch")).toNumber());
  r.status = v.get(QStringLiteral("status"));
  r.body = v.get(QStringLiteral("body"));
  const JValue& e = v.get(QStringLiteral("error"));
  if (e.isObject()) {
    r.errorCode = e.get(QStringLiteral("code")).stringOr(QStringLiteral("INTERNAL"));
    r.errorMessage = e.get(QStringLiteral("message")).stringOr(r.errorCode);
  }
  normalizeReply(r);
  if (r.workspaceId != it->call.workspaceId || r.clientEpoch != it->call.clientEpoch) {
    // A reply must echo the request's scope; anything else is not ours to apply.
    stats_.droppedReplies++;
    return;
  }
  const RpcCall call = it->call;
  inflight_.erase(it);
  order_.removeAll(id);
  if (call.internal) {
    if (call.methodId == QLatin1String("events.subscribe")) {
      auto s = subs_.find(call.workspaceId);
      if (s != subs_.end()) {
        if (r.errorCode == QLatin1String("EVENT_GAP")) markGap(call.workspaceId, QStringLiteral("cursor unavailable"));
        else if (r.ok()) {
          const JValue& c = r.body.get(QStringLiteral("cursor"));
          if (c.isNumber() && qint64(c.toNumber()) > s->cursor) {
            // The gateway may only move the cursor forward when it can replay; a jump is a gap.
            markGap(call.workspaceId, QStringLiteral("cursor moved"));
          }
        }
      }
    }
  } else {
    emit replied(r);
  }
  pump();
  publishStats();
}

void RpcWorker::markGap(const QString& ws, const QString& why) {
  auto s = subs_.find(ws);
  if (s == subs_.end() || s->gap) return;
  s->gap = true;
  stats_.gaps++;
  emit gap(ws, why);
}

void RpcWorker::handleEvent(const JValue& v) {
  RpcEvent ev;
  ev.workspaceId = v.get(QStringLiteral("workspaceId")).stringOr(QString());
  ev.eventSeq = qint64(v.get(QStringLiteral("eventSeq")).toNumber());
  ev.type = v.get(QStringLiteral("type")).stringOr(QString());
  ev.data = v.get(QStringLiteral("data"));
  auto s = subs_.find(ev.workspaceId);
  if (s == subs_.end() || !s->active) {
    stats_.droppedEvents++;
    return;
  }
  if (ev.type == QLatin1String("event.gap")) {
    markGap(ev.workspaceId, QStringLiteral("gateway reported a gap"));
    return;
  }
  if (ev.eventSeq <= s->cursor) return;  // already seen (replay after reconnect)
  if (s->gap || ev.eventSeq != s->cursor + 1) {
    if (!s->gap) markGap(ev.workspaceId, QStringLiteral("eventSeq %1 after %2").arg(ev.eventSeq).arg(s->cursor));
    // While a full re-read is pending, revocations still reach the UI (never lost behind a gap).
    if (ev.critical()) emit eventReady(ev);
    return;
  }
  if (uiBacklog_ >= maxUiBacklog && !ev.critical()) {
    // Slow reader: bounded. Drop and force a full re-read rather than queue without end.
    stats_.droppedEvents++;
    markGap(ev.workspaceId, QStringLiteral("ui backlog"));
    return;
  }
  s->cursor = ev.eventSeq;
  uiBacklog_++;
  emit eventReady(ev);
  if (++s->sinceAck >= 32) {
    s->sinceAck = 0;
    RpcCall c;
    c.workspaceId = ev.workspaceId;
    c.clientEpoch = s->clientEpoch;
    c.sessionEpoch = s->sessionEpoch;
    c.methodId = QStringLiteral("events.ack");
    c.params = JValue::object({{QStringLiteral("workspaceId"), ev.workspaceId}});
    c.body = JValue::object({{QStringLiteral("cursor"), double(s->cursor)}});
    sendInternal(c);
    s->ackedCursor = s->cursor;
  }
}

void RpcWorker::consumed(int n) { uiBacklog_ = std::max(0, uiBacklog_ - n); }

void RpcWorker::subscribe(QString ws, qint64 cursor, qint64 clientEpoch, qint64 sessionEpoch) {
  Sub& s = subs_[ws];
  s.cursor = cursor;
  s.clientEpoch = clientEpoch;
  s.sessionEpoch = sessionEpoch;
  s.gap = false;
  s.active = true;
  s.sinceAck = 0;
  RpcCall c;
  c.workspaceId = ws;
  c.clientEpoch = clientEpoch;
  c.sessionEpoch = sessionEpoch;
  c.methodId = QStringLiteral("events.subscribe");
  c.params = JValue::object({{QStringLiteral("workspaceId"), ws}});
  c.body = JValue::object({{QStringLiteral("cursor"), double(cursor)}});
  sendInternal(c);
}

void RpcWorker::unsubscribe(QString ws) { subs_.remove(ws); }

void RpcWorker::sendInternal(RpcCall c) {
  c.internal = true;
  c.requestId = QUuid::createUuid().toString(QUuid::WithoutBraces);
  if (isWriteRoute(c.methodId)) c.idempotencyKey = c.methodId + QLatin1Char(':') + c.workspaceId + QLatin1Char(':') + asText(c.body.get(QStringLiteral("cursor"))) + QLatin1Char(':') + c.requestId.left(8);
  queue_.push_front(c);
  pump();
}

void RpcWorker::localError(const RpcCall& c, const QString& code, const QString& msg) {
  RpcReply r;
  r.requestId = c.requestId;
  r.workspaceId = c.workspaceId;
  r.clientEpoch = c.clientEpoch;
  r.errorCode = code;
  r.errorMessage = msg;
  r.local = true;
  emit replied(r);
}

void RpcWorker::submit(RpcCall c) {
  static const QRegularExpression uuid(QStringLiteral("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"));
  if (!uuid.match(c.requestId).hasMatch()) return localError(c, QStringLiteral("INVALID_REQUEST"), QStringLiteral("requestId must be a lowercase uuid"));
  if (!isNativeRoute(c.methodId)) return localError(c, QStringLiteral("INVALID_REQUEST"), QStringLiteral("unknown method"));
  if (isWriteRoute(c.methodId) && c.idempotencyKey.isEmpty()) return localError(c, QStringLiteral("IDEMPOTENCY_REQUIRED"), QStringLiteral("write requires an idempotency key"));
  if (c.methodId == QLatin1String("workspace.forward")) {
    const QString why = checkForwardBody(c.body);
    if (!why.isEmpty()) return localError(c, QStringLiteral("INVALID_REQUEST"), why);
  }
  if (c.idempotencyKey.size() > 200) return localError(c, QStringLiteral("INVALID_REQUEST"), QStringLiteral("bad idempotency key"));
  if (int(queue_.size()) >= maxQueue) return localError(c, QStringLiteral("CLIENT_QUEUE_FULL"), QStringLiteral("too many queued requests"));
  if (inflight_.contains(c.requestId)) return;  // same requestId already in flight: the gateway answers once
  if (c.encode().size() > kMaxFrameBytes) return localError(c, QStringLiteral("FRAME_TOO_LARGE"), QStringLiteral("request exceeds 4 MiB"));
  queue_.push_back(c);
  pump();
}

bool RpcWorker::sendPending(Pending& p) {
  if (!sock_ || sock_->state() != QLocalSocket::ConnectedState) return false;
  sock_->write(p.frame);
  p.sent = true;
  p.since.start();
  return true;
}

void RpcWorker::pump() {
  const bool up = sock_ && sock_->state() == QLocalSocket::ConnectedState;
  while (up && !queue_.empty() && inflight_.size() < kMaxInflight && sock_->bytesToWrite() < writeHighWater) {
    RpcCall c = queue_.front();
    queue_.pop_front();
    Pending p;
    p.call = c;
    p.frame = encodeFrame(c.encode());
    inflight_.insert(c.requestId, p);
    order_ << c.requestId;
    sendPending(inflight_[c.requestId]);
  }
  stats_.maxInflightSeen = std::max(stats_.maxInflightSeen, int(inflight_.size()));
  publishStats();
}

void RpcWorker::onTick() {
  // 30 s without an answer: never conclude "not committed" — ask again by the SAME requestId (the gateway answers a
  // repeated requestId from its receipt) and tell the UI the result is pending/unknown.
  for (const QString& id : order_) {
    auto it = inflight_.find(id);
    if (it == inflight_.end() || !it->sent) continue;
    if (it->since.elapsed() >= statusAfterMs) {
      it->queries++;
      stats_.statusQueries++;
      if (!it->call.internal) emit pendingUnknown(id);
      sendPending(*it);
    }
  }
  publishStats();
}

void RpcWorker::publishStats() {
  stats_.inflight = int(inflight_.size());
  stats_.queued = int(queue_.size());
  stats_.bytesToWrite = sock_ ? sock_->bytesToWrite() : 0;
  emit statsChanged(stats_);
}

// ------------------------------------------------------------------ facade
RpcClient::RpcClient(QString socketPath, QObject* parent) : QObject(parent), worker_(new RpcWorker(std::move(socketPath))) {
  registerTypes();
  worker_->moveToThread(&thread_);
  connect(&thread_, &QThread::finished, worker_, &QObject::deleteLater);
  connect(worker_, &RpcWorker::replied, this, [this](const RpcReply& r) {
    auto cb = callbacks_.take(r.requestId);
    if (cb) cb(r);
  });
  connect(worker_, &RpcWorker::eventReady, this, [this](const RpcEvent& e) {
    emit eventReceived(e);
    QMetaObject::invokeMethod(worker_, "consumed", Qt::QueuedConnection, Q_ARG(int, 1));
  });
  connect(worker_, &RpcWorker::gap, this, &RpcClient::gap);
  connect(worker_, &RpcWorker::connectionChanged, this, [this](bool c) {
    connected_ = c;
    emit connectionChanged(c);
  });
  connect(worker_, &RpcWorker::pendingUnknown, this, &RpcClient::pendingUnknown);
  connect(worker_, &RpcWorker::protocolError, this, &RpcClient::protocolError);
  connect(worker_, &RpcWorker::statsChanged, this, [this](const RpcStats& s) {
    stats_ = s;
    emit statsChanged();
  });
  thread_.setObjectName(QStringLiteral("agentos-rpc"));
  thread_.start();
}

RpcClient::~RpcClient() {
  QMetaObject::invokeMethod(worker_, "stop", Qt::BlockingQueuedConnection);
  thread_.quit();
  thread_.wait();
}

QString RpcClient::defaultSocketPath() {
  const QByteArray env = qgetenv("AGENTOS_GATEWAY_SOCKET");
  return env.isEmpty() ? QStringLiteral("/run/agentos/gateway.sock") : QString::fromLocal8Bit(env);
}

QString RpcClient::newRequestId() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }

void RpcClient::start() { QMetaObject::invokeMethod(worker_, "start", Qt::QueuedConnection); }

QString RpcClient::call(RpcCall c, Callback cb) {
  if (c.requestId.isEmpty()) c.requestId = newRequestId();
  if (cb) callbacks_.insert(c.requestId, std::move(cb));
  QMetaObject::invokeMethod(worker_, "submit", Qt::QueuedConnection, Q_ARG(agentos::RpcCall, c));
  return c.requestId;
}

void RpcClient::subscribe(const QString& ws, qint64 cursor, qint64 ce, qint64 se) {
  QMetaObject::invokeMethod(worker_, "subscribe", Qt::QueuedConnection, Q_ARG(QString, ws), Q_ARG(qint64, cursor), Q_ARG(qint64, ce), Q_ARG(qint64, se));
}
void RpcClient::unsubscribe(const QString& ws) { QMetaObject::invokeMethod(worker_, "unsubscribe", Qt::QueuedConnection, Q_ARG(QString, ws)); }
void RpcClient::reconnectNow() { QMetaObject::invokeMethod(worker_, "reconnectNow", Qt::QueuedConnection); }
void RpcClient::forget(const QString& id) { callbacks_.remove(id); }

}  // namespace agentos
