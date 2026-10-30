// Transport limits against a real native-rpc/1 socket peer (spec §9.2): 4 MiB frames, 32 in flight, slow reader,
// reconnect with retry-by-requestId, 30 s wait -> status query by requestId (shortened here), write keys.
#include "fake_gateway.hpp"
#include "rpc_client.hpp"

#include <QElapsedTimer>
#include <QTemporaryDir>
#include <QtTest/QtTest>

using namespace agentos;
using namespace agentos::test;

static const QString kWs = QStringLiteral("44444444-4444-4444-8444-444444444444");

static RpcCall call(const QString& method, const JValue& body = JValue::null(), const QString& key = QString()) {
  RpcCall c;
  c.workspaceId = kWs;
  c.clientEpoch = 2;
  c.sessionEpoch = 1;
  c.methodId = method;
  c.body = body;
  c.idempotencyKey = key;
  return c;
}

class TransportTest : public QObject {
  Q_OBJECT
  QTemporaryDir dir;
  QString sock() { return dir.path() + QStringLiteral("/gw.sock"); }

 private slots:
  void frameCodec() {
    QByteArray f = encodeFrame("{\"a\":1}");
    QCOMPARE(f.toHex(), QByteArray("000000077b2261223a317d"));
    FrameDecoder d;
    d.feed(f.left(3));
    QByteArray p;
    QCOMPARE(d.next(&p), FrameDecoder::Status::NeedMore);
    d.feed(f.mid(3) + f);
    QCOMPARE(d.next(&p), FrameDecoder::Status::Frame);
    QCOMPARE(p, QByteArray("{\"a\":1}"));
    QCOMPARE(d.next(&p), FrameDecoder::Status::Frame);
    QCOMPARE(d.next(&p), FrameDecoder::Status::NeedMore);
    QVERIFY(encodeFrame(QByteArray(kMaxFrameBytes + 1, 'x')).isEmpty());
    QCOMPARE(encodeFrame(QByteArray(kMaxFrameBytes, 'x')).size(), kMaxFrameBytes + 4);
    FrameDecoder big;
    QByteArray h(4, 0);
    h[1] = 0x40;
    h[3] = 1;  // 4 MiB + 1
    big.feed(h);
    QCOMPARE(big.next(&p), FrameDecoder::Status::TooLarge);
  }

  void writeNeedsIdempotencyKey() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.start();
    QString code;
    c.call(call(QStringLiteral("workspace.forward"), JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}})), [&](const RpcReply& r) { code = r.errorCode; });
    QTRY_COMPARE(code, QStringLiteral("IDEMPOTENCY_REQUIRED"));
    code.clear();
    c.call(call(QStringLiteral("no.such.method")), [&](const RpcReply& r) { code = r.errorCode; });
    QTRY_COMPARE(code, QStringLiteral("INVALID_REQUEST"));
    // forward envelope: only registered route IDs; no URL/path/method/header/principal/socket/userId/executionUid
    for (const auto& bad : {JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("url"), QStringLiteral("http://x")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("headers"), JValue::object()}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("principal"), QStringLiteral("root")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("executionUid"), 0}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("userId"), QStringLiteral("u")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("/api/apps")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("http://evil/x")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("no.such.route")}}),
                            JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.get")}, {QStringLiteral("params"), JValue::object()}})}) {
      code.clear();
      c.call(call(QStringLiteral("workspace.forward"), bad, QStringLiteral("k")), [&](const RpcReply& r) { code = r.errorCode; });
      QTRY_COMPARE(code, QStringLiteral("INVALID_REQUEST"));
    }
    QCOMPARE(g.gw->requestsSeen(), 0);
  }

  void inflightCapIs32() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.start();
    QTRY_VERIFY(c.connected());
    int done = 0;
    for (int i = 0; i < 100; ++i) c.call(call(QStringLiteral("session.status")), [&](const RpcReply& r) { done += r.ok() ? 1 : 0; });
    QTRY_COMPARE(g.gw->requestsSeen(), 32);
    QTest::qWait(200);
    QCOMPARE(g.gw->requestsSeen(), 32);  // the 33rd waits for a free slot
    QVERIFY(c.stats().queued >= 60);
    for (int round = 0; round < 10 && done < 100; ++round) {
      QMetaObject::invokeMethod(g.gw, "replyAllOpen", Qt::BlockingQueuedConnection, Q_ARG(agentos::JValue, JValue::object()));
      QTest::qWait(100);
    }
    QTRY_COMPARE(done, 100);
    QVERIFY(g.gw->maxOpen() <= kMaxInflight);
    QCOMPARE(g.gw->closedForLimit(), 0);
    QVERIFY(c.stats().maxInflightSeen <= kMaxInflight);
  }

  void frameLimits() {
    GatewayThread g(sock());
    g.gw->setHandler([](const JValue&) { return JValue::object({{QStringLiteral("ok"), true}}); });
    RpcClient c(sock());
    c.start();
    QTRY_VERIFY(c.connected());
    QString code;
    c.call(call(QStringLiteral("session.status"), JValue(QString(kMaxFrameBytes, QLatin1Char('x')))), [&](const RpcReply& r) { code = r.errorCode; });
    QTRY_COMPARE(code, QStringLiteral("FRAME_TOO_LARGE"));
    QCOMPARE(g.gw->requestsSeen(), 0);
    bool ok = false;
    c.call(call(QStringLiteral("session.status"), JValue(QString(kMaxFrameBytes - 400, QLatin1Char('y')))), [&](const RpcReply& r) { ok = r.ok(); });
    QTRY_VERIFY_WITH_TIMEOUT(ok, 10000);
    QCOMPARE(g.gw->closedForLimit(), 0);
    // A gateway frame over 4 MiB closes the connection; the client reconnects and re-sends by requestId.
    g.gw->setHandler({});
    bool answered = false;
    QString id = c.call(call(QStringLiteral("workspace.forward"), JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}}), QStringLiteral("key-big")), [&](const RpcReply& r) { answered = r.ok(); });
    QTRY_COMPARE(g.gw->requestsSeen(), 2);
    const int connsBefore = g.gw->connections();
    QMetaObject::invokeMethod(g.gw, "sendRawFrameHeader", Qt::BlockingQueuedConnection, Q_ARG(quint32, quint32(kMaxFrameBytes + 1)));
    QTRY_VERIFY_WITH_TIMEOUT(g.gw->connections() > connsBefore, 5000);
    QTRY_COMPARE(g.gw->requestsSeen(), 3);
    auto reqs = g.gw->requests();
    QCOMPARE(reqs.last().get(QStringLiteral("requestId")).str(), id);
    QCOMPARE(reqs.last().get(QStringLiteral("idempotencyKey")).str(), QStringLiteral("key-big"));
    QMetaObject::invokeMethod(g.gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, id), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY(answered);
    QVERIFY(c.stats().protocolErrors >= 1);
  }

  void reconnectRetriesByRequestId() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.start();
    QTRY_VERIFY(c.connected());
    int calls = 0;
    QStringList ids;
    for (int i = 0; i < 5; ++i)
      ids << c.call(call(QStringLiteral("workspace.forward"), JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}, {QStringLiteral("body"), JValue::object({{QStringLiteral("n"), i}})}}), QStringLiteral("k%1").arg(i)), [&](const RpcReply&) { calls++; });
    QTRY_COMPARE(g.gw->requestsSeen(), 5);
    QMetaObject::invokeMethod(g.gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(g.gw->requestsSeen() == 10, 5000);
    auto reqs = g.gw->requests();
    for (int i = 0; i < 5; ++i) {
      QCOMPARE(reqs[5 + i].get(QStringLiteral("requestId")).str(), ids[i]);
      QCOMPARE(reqs[5 + i].get(QStringLiteral("idempotencyKey")).str(), QStringLiteral("k%1").arg(i));
      QVERIFY(reqs[5 + i].deepEquals(reqs[i]));
    }
    QMetaObject::invokeMethod(g.gw, "replyAllOpen", Qt::BlockingQueuedConnection, Q_ARG(agentos::JValue, JValue::object()));
    QTRY_COMPARE(calls, 5);
    // a second (duplicate) answer to the same requestId is ignored
    for (const QString& id : ids) QMetaObject::invokeMethod(g.gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, id), Q_ARG(agentos::JValue, JValue::object()));
    QTest::qWait(200);
    QCOMPARE(calls, 5);
    QVERIFY(c.stats().reconnects >= 1);
  }

  void slowReaderIsBounded() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.worker()->writeHighWater = 2 * 1024 * 1024;
    c.start();
    QTRY_VERIFY(c.connected());
    QMetaObject::invokeMethod(g.gw, "pauseReading", Qt::BlockingQueuedConnection, Q_ARG(bool, true));
    int done = 0;
    const QString mb(1024 * 1024, QLatin1Char('z'));
    for (int i = 0; i < 40; ++i) c.call(call(QStringLiteral("session.status"), JValue(mb)), [&](const RpcReply&) { done++; });
    // The UI thread keeps running while the peer does not read.
    QElapsedTimer t;
    t.start();
    qint64 worst = 0, last = 0;
    while (t.elapsed() < 1500) {
      QTest::qWait(10);
      worst = std::max(worst, t.elapsed() - last);
      last = t.elapsed();
    }
    QVERIFY2(worst < 250, qPrintable(QString::number(worst)));
    QVERIFY(c.stats().bytesToWrite <= 2 * 1024 * 1024 + 4 * 1024 * 1024 + 64);
    QVERIFY(c.stats().queued > 0);  // held back instead of buffering everything
    g.gw->setHandler([](const JValue&) { return JValue::object(); });
    QMetaObject::invokeMethod(g.gw, "pauseReading", Qt::BlockingQueuedConnection, Q_ARG(bool, false));
    QMetaObject::invokeMethod(g.gw, "replyAllOpen", Qt::BlockingQueuedConnection, Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY_WITH_TIMEOUT(done == 40, 20000);
  }

  void statusQueryAfterWait() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.worker()->statusAfterMs = 400;
    c.start();
    QTRY_VERIFY(c.connected());
    QStringList unknown;
    connect(&c, &RpcClient::pendingUnknown, this, [&](const QString& id) { unknown << id; });
    int answered = 0;
    QString id = c.call(call(QStringLiteral("workspace.forward"), JValue::object({{QStringLiteral("routeId"), QStringLiteral("runs.list")}}), QStringLiteral("slow-key")), [&](const RpcReply&) { answered++; });
    QTRY_COMPARE(g.gw->requestsSeen(), 1);
    QTRY_VERIFY_WITH_TIMEOUT(unknown.contains(id), 3000);
    QTRY_VERIFY(g.gw->requestsSeen() >= 2);
    auto reqs = g.gw->requests();
    QCOMPARE(reqs[1].get(QStringLiteral("requestId")).str(), id);  // same requestId, never a new one
    QCOMPARE(reqs[1].get(QStringLiteral("idempotencyKey")).str(), QStringLiteral("slow-key"));
    QCOMPARE(answered, 0);  // no synthesized failure
    QMetaObject::invokeMethod(g.gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, id), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_COMPARE(answered, 1);
  }

  void replyScopeMustMatch() {
    GatewayThread g(sock());
    RpcClient c(sock());
    c.start();
    QTRY_VERIFY(c.connected());
    int answered = 0;
    QString id = c.call(call(QStringLiteral("session.status")), [&](const RpcReply&) { answered++; });
    QTRY_COMPARE(g.gw->requestsSeen(), 1);
    JValue wrong = JValue::object({{QStringLiteral("requestId"), id}, {QStringLiteral("workspaceId"), kWs}, {QStringLiteral("clientEpoch"), 99.0}, {QStringLiteral("status"), 200.0}, {QStringLiteral("body"), JValue::object()}});
    QMetaObject::invokeMethod(g.gw, "sendPayload", Qt::BlockingQueuedConnection, Q_ARG(QByteArray, wrong.toJsonUtf8()));
    QTRY_VERIFY(c.stats().droppedReplies >= 1);
    QCOMPARE(answered, 0);
    // malformed JSON (duplicate key) is a protocol error: connection closed, request re-sent
    QMetaObject::invokeMethod(g.gw, "sendPayload", Qt::BlockingQueuedConnection, Q_ARG(QByteArray, QByteArray("{\"requestId\":\"a\",\"requestId\":\"b\"}")));
    QTRY_VERIFY_WITH_TIMEOUT(g.gw->requestsSeen() >= 2, 5000);
    QVERIFY(c.stats().protocolErrors >= 1);
  }
};

QTEST_GUILESS_MAIN(TransportTest)
#include "transport_test.moc"
