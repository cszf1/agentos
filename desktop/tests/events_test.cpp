// Event cursor, EVENT_GAP full re-read, slow UI reader bounded without losing revocations (spec §9.2, V1-D09).
#include "fake_gateway.hpp"
#include "rpc_client.hpp"

#include <QTemporaryDir>
#include <QThread>
#include <QtTest/QtTest>

using namespace agentos;
using namespace agentos::test;
static const QString kWs = QStringLiteral("44444444-4444-4444-8444-444444444444");

class EventsTest : public QObject {
  Q_OBJECT
  QTemporaryDir dir;
  QString sock() { return dir.path() + QStringLiteral("/gw.sock"); }
  static void ev(GatewayThread& g, qint64 seq, const QString& type = QStringLiteral("operation.state_changed")) {
    QMetaObject::invokeMethod(g.gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, kWs), Q_ARG(qint64, seq), Q_ARG(QString, type),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("n"), double(seq)}})));
  }
  static int subscribes(GatewayThread& g, qint64* lastCursor = nullptr) {
    int n = 0;
    for (const auto& r : g.gw->requests())
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) {
        n++;
        if (lastCursor) *lastCursor = qint64(r.get(QStringLiteral("body")).get(QStringLiteral("cursor")).toNumber());
      }
    return n;
  }

 private slots:
  void cursorGapAndResync() {
    GatewayThread g(sock());
    g.gw->setHandler([](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) return JValue::object({{QStringLiteral("cursor"), r.get(QStringLiteral("body")).get(QStringLiteral("cursor"))}});
      return JValue::object();
    });
    RpcClient c(sock());
    QVector<qint64> seen;
    QStringList types, gaps;
    connect(&c, &RpcClient::eventReceived, this, [&](const RpcEvent& e) {
      seen << e.eventSeq;
      types << e.type;
    });
    connect(&c, &RpcClient::gap, this, [&](const QString& ws, const QString& why) { gaps << ws + QLatin1Char(':') + why; });
    c.start();
    QTRY_VERIFY(c.connected());
    c.subscribe(kWs, 0, 2, 1);
    QTRY_COMPARE(subscribes(g), 1);
    ev(g, 1);
    ev(g, 2);
    ev(g, 2);  // duplicate after replay: ignored
    ev(g, 3);
    QTRY_COMPARE(seen, (QVector<qint64>{1, 2, 3}));
    // reconnect: resubscribe from the last confirmed cursor
    QMetaObject::invokeMethod(g.gw, "dropConnection", Qt::BlockingQueuedConnection);
    qint64 cur = -1;
    QTRY_VERIFY_WITH_TIMEOUT(subscribes(g, &cur) == 2, 5000);
    QCOMPARE(cur, qint64(3));
    ev(g, 4);
    QTRY_COMPARE(seen.size(), 4);
    // a hole -> gap; later non-critical events are held back until the full re-read; revocation still delivered
    ev(g, 6);
    QTRY_COMPARE(gaps.size(), 1);
    ev(g, 7);
    ev(g, 8, QStringLiteral("membership.revoked"));
    QTRY_VERIFY(types.contains(QStringLiteral("membership.revoked")));
    QVERIFY(!seen.contains(6) && !seen.contains(7));
    // full snapshot taken by the UI says cursor 20; subscribe from there
    c.subscribe(kWs, 20, 2, 1);
    QTRY_COMPARE(subscribes(g), 3);
    ev(g, 21);
    QTRY_VERIFY(seen.contains(21));
    // gateway-reported gap event
    ev(g, 22, QStringLiteral("event.gap"));
    QTRY_COMPARE(gaps.size(), 2);
  }

  void subscribeEventGapError() {
    GatewayThread g(sock());
    g.gw->setHandler([](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe"))
        return JValue::object({{QStringLiteral("__error"), JValue::object({{QStringLiteral("code"), QStringLiteral("EVENT_GAP")}, {QStringLiteral("message"), QStringLiteral("cursor expired")}})}});
      return JValue::object();
    });
    RpcClient c(sock());
    QStringList gaps;
    connect(&c, &RpcClient::gap, this, [&](const QString& ws, const QString&) { gaps << ws; });
    c.start();
    QTRY_VERIFY(c.connected());
    c.subscribe(kWs, 5, 2, 1);
    QTRY_COMPARE(gaps, QStringList{kWs});
  }

  void slowUiReaderBoundedKeepsRevocation() {
    GatewayThread g(sock());
    g.gw->setHandler([](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) return JValue::object({{QStringLiteral("cursor"), r.get(QStringLiteral("body")).get(QStringLiteral("cursor"))}});
      return JValue::object();
    });
    RpcClient c(sock());
    c.worker()->maxUiBacklog = 8;
    QStringList types;
    int gaps = 0;
    connect(&c, &RpcClient::eventReceived, this, [&](const RpcEvent& e) { types << e.type; });
    connect(&c, &RpcClient::gap, this, [&](const QString&, const QString&) { gaps++; });
    c.start();
    QTRY_VERIFY(c.connected());
    c.subscribe(kWs, 0, 2, 1);
    QTRY_COMPARE(subscribes(g), 1);
    // Block the UI thread while the gateway pushes 100 events; the worker must not queue them without bound.
    QMetaObject::invokeMethod(g.gw, [&g] {
      for (int i = 1; i <= 100; ++i) g.gw->sendEvent(kWs, i, i == 60 ? QStringLiteral("membership.revoking") : QStringLiteral("operation.state_changed"), JValue::object());
    }, Qt::QueuedConnection);
    QThread::msleep(800);
    QTRY_VERIFY(gaps >= 1);
    QTRY_VERIFY(types.contains(QStringLiteral("membership.revoking")));
    QVERIFY(types.size() < 100);
    QVERIFY(c.stats().droppedEvents > 0 || c.stats().gaps > 0);
  }

  void acksEvery32() {
    GatewayThread g(sock());
    g.gw->setHandler([](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) return JValue::object({{QStringLiteral("cursor"), r.get(QStringLiteral("body")).get(QStringLiteral("cursor"))}});
      return JValue::object();
    });
    RpcClient c(sock());
    int n = 0;
    connect(&c, &RpcClient::eventReceived, this, [&](const RpcEvent&) { n++; });
    c.start();
    QTRY_VERIFY(c.connected());
    c.subscribe(kWs, 0, 2, 1);
    QTRY_COMPARE(subscribes(g), 1);
    for (int i = 1; i <= 40; ++i) ev(g, i);
    QTRY_COMPARE(n, 40);
    bool acked = false;
    QTRY_VERIFY_WITH_TIMEOUT(([&] {
      for (const auto& r : g.gw->requests())
        if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.ack") && r.get(QStringLiteral("body")).get(QStringLiteral("cursor")).toNumber() == 32 &&
            !r.get(QStringLiteral("idempotencyKey")).str().isEmpty())
          acked = true;
      return acked;
    }()), 3000);
  }
};

QTEST_GUILESS_MAIN(EventsTest)
#include "events_test.moc"
