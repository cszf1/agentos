#pragma once
// native-rpc/1 client over the gateway UDS (spec §9.2, §10.1). All socket I/O runs on a worker thread; the Qt UI
// thread only posts calls and receives replies/events through queued signals, so it never blocks on the gateway.
//
// Wire shapes the Shell speaks (the gateway side lives in native/; see desktop/README.md):
//   request  {requestId, workspaceId, clientEpoch, sessionEpoch, methodId, params, body, idempotencyKey?}
//   response {requestId, workspaceId, clientEpoch, status, body} | {requestId, workspaceId, clientEpoch, status, error:{code,message}}
//   event    {workspaceId, eventSeq, type, data}          (unsolicited, per-workspace monotonic eventSeq)
#include "frame_codec.hpp"
#include "jvalue.hpp"

#include <QElapsedTimer>
#include <QHash>
#include <QLocalSocket>
#include <QObject>
#include <QPointer>
#include <QThread>
#include <QTimer>
#include <deque>
#include <functional>

namespace agentos {

struct RpcCall {
  QString requestId;
  QString workspaceId;
  qint64 clientEpoch = 1;
  qint64 sessionEpoch = 1;
  QString methodId;
  JValue params = JValue::null();
  JValue body = JValue::null();
  QString idempotencyKey;
  bool internal = false;  // subscribe/ack issued by the transport itself
  QByteArray encode() const;
};

struct RpcReply {
  QString requestId, workspaceId;
  qint64 clientEpoch = 0;
  JValue status;
  JValue body;
  QString errorCode, errorMessage;
  bool local = false;  // produced by the client (never reached the gateway)
  bool ok() const { return errorCode.isEmpty(); }
};

struct RpcEvent {
  QString workspaceId;
  qint64 eventSeq = 0;
  QString type;
  JValue data;
  bool critical() const;
};

struct RpcStats {
  int inflight = 0, queued = 0, maxInflightSeen = 0;
  int reconnects = 0, resent = 0, statusQueries = 0, protocolErrors = 0, droppedReplies = 0, droppedEvents = 0, gaps = 0;
  qint64 bytesToWrite = 0;
};

class RpcWorker : public QObject {
  Q_OBJECT
 public:
  explicit RpcWorker(QString socketPath);
  ~RpcWorker() override;
  int statusAfterMs = 30000;
  int maxQueue = 1024;
  int maxUiBacklog = 512;
  qint64 writeHighWater = 16 * 1024 * 1024;

 public slots:
  void start();
  void stop();
  void submit(agentos::RpcCall call);
  void subscribe(QString workspaceId, qint64 cursor, qint64 clientEpoch, qint64 sessionEpoch);
  void unsubscribe(QString workspaceId);
  void consumed(int n);
  void reconnectNow();
  void setSocketPath(QString path);

 signals:
  void replied(agentos::RpcReply reply);
  void pendingUnknown(QString requestId);
  void eventReady(agentos::RpcEvent ev);
  void gap(QString workspaceId, QString reason);
  void connectionChanged(bool connected);
  void protocolError(QString what);
  void statsChanged(agentos::RpcStats stats);

 private:
  struct Pending {
    RpcCall call;
    QByteArray frame;
    QElapsedTimer since;
    bool sent = false;
    int queries = 0;
  };
  struct Sub {
    qint64 cursor = 0;
    qint64 clientEpoch = 1, sessionEpoch = 1;
    bool gap = false;
    bool active = false;
    qint64 ackedCursor = 0;
    int sinceAck = 0;
  };
  QString path_;
  QLocalSocket* sock_ = nullptr;
  QTimer* tick_ = nullptr;
  QTimer* retry_ = nullptr;
  FrameDecoder dec_;
  std::deque<RpcCall> queue_;
  QHash<QString, Pending> inflight_;
  QStringList order_;  // inflight requestIds in send order (resend keeps order)
  QHash<QString, Sub> subs_;
  int backoffMs_ = 100;
  int uiBacklog_ = 0;
  bool stopped_ = false;
  RpcStats stats_;

  void connectSocket();
  void onConnected();
  void onDisconnected();
  void onReadyRead();
  void handleFrame(const QByteArray& payload);
  void handleReply(const JValue& v);
  void handleEvent(const JValue& v);
  void pump();
  bool sendPending(Pending& p);
  void localError(const RpcCall& c, const QString& code, const QString& msg);
  void markGap(const QString& ws, const QString& why);
  void sendInternal(RpcCall c);
  void onTick();
  void abortConnection(const QString& why);
  void publishStats();
};

/** UI-thread facade: owns the worker thread; callbacks run on the UI thread. */
class RpcClient : public QObject {
  Q_OBJECT
 public:
  using Callback = std::function<void(const RpcReply&)>;
  explicit RpcClient(QString socketPath, QObject* parent = nullptr);
  ~RpcClient() override;
  static QString defaultSocketPath();
  static QString newRequestId();
  RpcWorker* worker() const { return worker_; }
  void start();
  /** Fills requestId when empty; returns it. */
  QString call(RpcCall call, Callback cb = {});
  void subscribe(const QString& ws, qint64 cursor, qint64 clientEpoch, qint64 sessionEpoch);
  void unsubscribe(const QString& ws);
  void reconnectNow();
  /** Forget callbacks of requests that belong to a scope the UI left (their late replies are dropped). */
  void forget(const QString& requestId);
  bool connected() const { return connected_; }
  RpcStats stats() const { return stats_; }

 signals:
  void eventReceived(agentos::RpcEvent ev);
  void gap(QString workspaceId, QString reason);
  void connectionChanged(bool connected);
  void pendingUnknown(QString requestId);
  void protocolError(QString what);
  void statsChanged();

 private:
  QThread thread_;
  RpcWorker* worker_;
  QHash<QString, Callback> callbacks_;
  bool connected_ = false;
  RpcStats stats_;
};

}  // namespace agentos

Q_DECLARE_METATYPE(agentos::RpcCall)
Q_DECLARE_METATYPE(agentos::RpcReply)
Q_DECLARE_METATYPE(agentos::RpcEvent)
Q_DECLARE_METATYPE(agentos::RpcStats)
