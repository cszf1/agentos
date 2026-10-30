// End-to-end Shell flows against an in-test native-rpc/1 peer (spec §11; V1-D02/04/07/08/09/10/11/12).
// The peer answers with fixture-shaped data; every request is recorded so the test checks what the Shell sent.
#include "fake_gateway.hpp"
#include "gui_support.hpp"

#include <QClipboard>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QQuickStyle>
#include <QTemporaryDir>
#include <atomic>

using namespace agentos;
using namespace agentos::test;

static const QString WS_A = QStringLiteral("44444444-4444-4444-8444-444444444444");
static const QString WS_B = QStringLiteral("55555555-5555-4555-8555-555555555555");

static QStringList g_qmlWarnings;
static QtMessageHandler g_prev = nullptr;
static void captureQml(QtMsgType t, const QMessageLogContext& c, const QString& m) {
  if (t >= QtWarningMsg && (m.contains(QLatin1String("qrc:/agentos/qml")) || m.contains(QLatin1String("qml:")))) g_qmlWarnings << m;
  if (g_prev) g_prev(t, c, m);
}

/** Scripted machine state the peer answers from. */
struct Backend {
  std::atomic<int> sessionEpoch{1};
  std::atomic<bool> locked{false};
  std::atomic<bool> hostDown{false}, modelDown{false}, brokerDown{false}, planStale{false}, holdQueries{false};
  JValue kanban = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v2-kanban.json"));
  JValue console = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-system-console.json"));
  JValue records = loadFixture(QStringLiteral("todo-v2.json"));
  QString maint = QStringLiteral("running");

  JValue appDetail(const QString& appId) const {
    for (const JValue* sc : {&kanban, &console}) {
      const JValue& a = sc->get(QStringLiteral("app"));
      if (a.get(QStringLiteral("appId")).str() == appId)
        return JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("appEpoch"), a.get(QStringLiteral("appEpoch"))}, {QStringLiteral("activeRevisionId"), a.get(QStringLiteral("revisionId"))}, {QStringLiteral("bundle"), sc->get(QStringLiteral("bundle"))}});
    }
    return JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("appEpoch"), 3}, {QStringLiteral("activeRevisionId"), QStringLiteral("rec-r1")}, {QStringLiteral("bundle"), records}});
  }
  JValue queryOutput(const QString& appId, const QString& queryId) const {
    for (const JValue* sc : {&kanban, &console}) {
      if (sc->get(QStringLiteral("app")).get(QStringLiteral("appId")).str() != appId) continue;
      const JValue& ds = sc->get(QStringLiteral("bundle")).get(QStringLiteral("view")).get(QStringLiteral("dataSources"));
      for (const auto& m : ds.members())
        if (m.second.get(QStringLiteral("queryId")).str() == queryId)
          for (const auto& st : sc->get(QStringLiteral("steps")).items())
            if (st.get(QStringLiteral("op")).str() == QLatin1String("load") && st.get(QStringLiteral("source")).str() == m.first) return decodeMissing(st.get(QStringLiteral("output")));
    }
    return JValue::object();
  }
  static JValue err(const QString& code) {
    return JValue::object({{QStringLiteral("__error"), JValue::object({{QStringLiteral("code"), code}, {QStringLiteral("message"), code}})}});
  }

  JValue handle(const JValue& req) {
    const QString m = req.get(QStringLiteral("methodId")).str();
    const JValue& p = req.get(QStringLiteral("params"));
    const JValue& b = req.get(QStringLiteral("body"));
    if (m == QLatin1String("session.bind") || m == QLatin1String("session.status"))
      return JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}, {QStringLiteral("userName"), QStringLiteral("alice")}, {QStringLiteral("role"), QStringLiteral("owner")}, {QStringLiteral("sessionEpoch"), double(sessionEpoch.load())}, {QStringLiteral("locked"), locked.load()}});
    if (m == QLatin1String("workspaces.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("workspaceId"), WS_A}, {QStringLiteral("displayName"), QString::fromUtf8("家庭")}, {QStringLiteral("state"), QStringLiteral("running")}}),
                                                                      JValue::object({{QStringLiteral("workspaceId"), WS_B}, {QStringLiteral("displayName"), QString::fromUtf8("工作")}, {QStringLiteral("state"), QStringLiteral("running")}})})}});
    if (m == QLatin1String("workspaces.attach"))
      return JValue::object({{QStringLiteral("workspaceId"), p.get(QStringLiteral("workspaceId"))}, {QStringLiteral("clientEpoch"), 2}, {QStringLiteral("storeUUID"), QStringLiteral("store-") + p.get(QStringLiteral("workspaceId")).str().left(4)}, {QStringLiteral("cursor"), 10}});
    if (m == QLatin1String("events.subscribe")) return JValue::object({{QStringLiteral("cursor"), b.get(QStringLiteral("cursor"))}});
    if (m == QLatin1String("events.ack") || m == QLatin1String("members.list") || m == QLatin1String("backups.list")) return JValue::object({{QStringLiteral("items"), JValue::array()}});
    if (m == QLatin1String("machine.status"))
      return JValue::object({{QStringLiteral("release"), JValue::object({{QStringLiteral("releaseId"), QStringLiteral("1.0.0")}})},
                             {QStringLiteral("components"), JValue::object({{QStringLiteral("host"), hostDown ? QStringLiteral("down") : QStringLiteral("ok")}, {QStringLiteral("model"), modelDown ? QStringLiteral("down") : QStringLiteral("ok")}, {QStringLiteral("broker"), brokerDown ? QStringLiteral("down") : QStringLiteral("ok")}})},
                             {QStringLiteral("setup"), JValue::object({{QStringLiteral("state"), QStringLiteral("done")}, {QStringLiteral("steps"), JValue::array()}})}});
    if (m == QLatin1String("machine.capabilities"))
      return JValue::object({{QStringLiteral("hardware"), JValue::object({
                                 {QStringLiteral("audio"), JValue::object({{QStringLiteral("available"), true}, {QStringLiteral("volume"), 40}, {QStringLiteral("muted"), false}, {QStringLiteral("outputs"), JValue::array({QStringLiteral("speaker")})}, {QStringLiteral("output"), QStringLiteral("speaker")}})},
                                 {QStringLiteral("display"), JValue::object({{QStringLiteral("available"), true}, {QStringLiteral("outputs"), JValue::array({JValue::object({{QStringLiteral("name"), QStringLiteral("Virtual-1")}, {QStringLiteral("modes"), JValue::array({QStringLiteral("1280x800"), QStringLiteral("1920x1080")})}, {QStringLiteral("current"), QStringLiteral("1280x800")}, {QStringLiteral("scale"), 1}})})}})},
                                 {QStringLiteral("network"), JValue::object({{QStringLiteral("available"), false}})},
                                 {QStringLiteral("brightness"), JValue::object({{QStringLiteral("available"), false}})},
                                 {QStringLiteral("battery"), JValue::object({{QStringLiteral("available"), false}})},
                                 {QStringLiteral("time"), JValue::object({{QStringLiteral("available"), false}})},
                                 {QStringLiteral("power"), JValue::object({{QStringLiteral("available"), true}})},
                                 {QStringLiteral("session"), JValue::object({{QStringLiteral("available"), true}})}})}});
    if (m == QLatin1String("machine.actions.plan"))
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('2'))}, {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("ticket"), QStringLiteral("ticket-1")},
                             {QStringLiteral("actionKind"), b.get(QStringLiteral("actionKind"))}, {QStringLiteral("summary"), JValue::object({{QStringLiteral("resource"), b.get(QStringLiteral("actionKind"))}, {QStringLiteral("version"), QStringLiteral("generation 7")}, {QStringLiteral("effect"), b.get(QStringLiteral("params")).stringify()}})}});
    if (m == QLatin1String("machine.actions.confirm")) return planStale ? err(QStringLiteral("PLAN_STALE")) : JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("state"), QStringLiteral("dispatching")}});
    if (m == QLatin1String("machine.actions.get"))
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("state"), QStringLiteral("succeeded")}, {QStringLiteral("actionKind"), lastKind}, {QStringLiteral("previous"), JValue::object({{QStringLiteral("output"), QStringLiteral("Virtual-1")}, {QStringLiteral("mode"), QStringLiteral("1280x800")}, {QStringLiteral("scale"), 1}})}});
    if (m == QLatin1String("machine.actions.cancel")) return JValue::object({{QStringLiteral("state"), QStringLiteral("cancelled")}});
    if (m == QLatin1String("updates.status")) return JValue::object({{QStringLiteral("current"), QStringLiteral("1.0.0")}, {QStringLiteral("state"), QStringLiteral("idle")}});
    if (m != QLatin1String("workspace.forward")) return JValue::object();
    const QString route = b.get(QStringLiteral("routeId")).str();
    const JValue& fp = b.get(QStringLiteral("params"));
    if (hostDown) return err(QStringLiteral("HOST_UNAVAILABLE"));
    if (route == QLatin1String("state.list"))
      return JValue::object({{QStringLiteral("apps"), JValue::array({
                                 JValue::object({{QStringLiteral("appId"), kanban.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("title"), QString::fromUtf8("待办看板")}, {QStringLiteral("appEpoch"), 3}}),
                                 JValue::object({{QStringLiteral("appId"), console.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("title"), QString::fromUtf8("系统控制台")}, {QStringLiteral("appEpoch"), 3}}),
                                 JValue::object({{QStringLiteral("appId"), QStringLiteral("rec-app")}, {QStringLiteral("title"), QString::fromUtf8("记录")}, {QStringLiteral("appEpoch"), 3}})})}});
    if (route == QLatin1String("apps.get")) return appDetail(fp.get(QStringLiteral("appId")).str());
    if (route == QLatin1String("apps.queries.post")) {
      if (holdQueries) return JValue();  // answered later by the test
      return JValue::object({{QStringLiteral("output"), queryOutput(fp.get(QStringLiteral("appId")).str(), fp.get(QStringLiteral("queryId")).str())}, {QStringLiteral("revisionId"), appDetail(fp.get(QStringLiteral("appId")).str()).get(QStringLiteral("activeRevisionId"))}, {QStringLiteral("appEpoch"), 3}});
    }
    if (route == QLatin1String("apps.records.list")) return JValue::object({{QStringLiteral("items"), JValue::array()}, {QStringLiteral("total"), 0}});
    if (route == QLatin1String("apps.records.post")) return JValue::object({{QStringLiteral("id"), QStringLiteral("r-1")}, {QStringLiteral("recordVersion"), 1}});
    if (route == QLatin1String("apps.systemactions.post")) return brokerDown ? err(QStringLiteral("BROKER_UNAVAILABLE")) : JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("confirmationRequired"), true}});
    if (route == QLatin1String("systemactions.get"))
      return JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("phase"), QStringLiteral("awaiting_confirmation")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('9'))}, {QStringLiteral("handlerId"), QStringLiteral("setCpu")}, {QStringLiteral("resourceId"), QStringLiteral("app:console")}, {QStringLiteral("appEpoch"), 3}});
    if (route == QLatin1String("systemactions.confirm.post")) return JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("phase"), QStringLiteral("applied")}});
    if (route == QLatin1String("runs.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("intent"), QString::fromUtf8("做个记账应用")}, {QStringLiteral("status"), QStringLiteral("running")}, {QStringLiteral("conversationId"), QStringLiteral("conv-1")}})})}});
    if (route == QLatin1String("runs.cancel.post")) return JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("status"), QStringLiteral("cancelling")}});
    if (route == QLatin1String("runs.get")) return JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("status"), QStringLiteral("cancelled")}});
    if (route == QLatin1String("runs.post")) return modelDown ? err(QStringLiteral("MODEL_UNAVAILABLE")) : JValue::object({{QStringLiteral("runId"), QStringLiteral("run-2")}, {QStringLiteral("status"), QStringLiteral("queued")}});
    if (route == QLatin1String("maintenance.state.list")) return JValue::object({{QStringLiteral("state"), maint}, {QStringLiteral("circuits"), JValue::array()}});
    if (route == QLatin1String("maintenance.control.post")) {
      maint = b.get(QStringLiteral("body")).get(QStringLiteral("action")).str() == QLatin1String("pause") ? QStringLiteral("paused") : QStringLiteral("running");
      return JValue::object({{QStringLiteral("state"), maint}});
    }
    if (route == QLatin1String("proposals.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("proposalId"), QStringLiteral("prop-1")}, {QStringLiteral("state"), QStringLiteral("ready")}, {QStringLiteral("proposalHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('f'))}, {QStringLiteral("baseAppEpoch"), 3}, {QStringLiteral("label"), QString::fromUtf8("修复看板")}})})}});
    if (route == QLatin1String("proposals.accept.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("committed")}});
    if (route == QLatin1String("apps.archive.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("archived")}});
    if (route == QLatin1String("apps.restore.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("active")}});
    if (route == QLatin1String("conversations.compactions.post")) return JValue::object({{QStringLiteral("compactionId"), QStringLiteral("cmp-1")}, {QStringLiteral("state"), QStringLiteral("completed")}});
    if (route.endsWith(QLatin1String(".list"))) return JValue::object({{QStringLiteral("items"), JValue::array()}});
    return JValue::object();
  }
  QString lastKind = QStringLiteral("audio.volume.set");
};

struct Harness {
  QTemporaryDir dir;
  Backend be;
  std::unique_ptr<GatewayThread> gw;
  std::unique_ptr<ShellController> shell;
  std::unique_ptr<View> view;
  Harness() {
    gw = std::make_unique<GatewayThread>(dir.path() + QStringLiteral("/gw.sock"));
    gw->gw->setHandler([this](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("machine.actions.plan")) be.lastKind = r.get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str();
      return be.handle(r);
    });
    shell = std::make_unique<ShellController>(dir.path() + QStringLiteral("/gw.sock"));
    shell->setLayoutDir(dir.path());
    view = std::make_unique<View>(shell.get(), QSize(1280, 900));
  }
  bool up() {
    if (!view->load(QStringLiteral("ShellRoot.qml"))) return false;
    shell->start();
    return QTest::qWaitFor([&] { return shell->sessionBound() && shell->workspaceId() == WS_A && static_cast<CanvasModel*>(shell->canvas())->count() == 3; }, 8000);
  }
  QVector<JValue> sent(const QString& methodOrRoute) const {
    QVector<JValue> out;
    for (const auto& r : gw->gw->requests())
      if (r.get(QStringLiteral("methodId")).str() == methodOrRoute || r.get(QStringLiteral("body")).get(QStringLiteral("routeId")).str() == methodOrRoute) out << r;
    return out;
  }
  QQuickItem* find(const QString& n) const { return findByObjectName(view->root(), n); }
  void click(const QString& n) {
    QQuickItem* b = find(n);
    QVERIFY2(b, qPrintable(n));
    QVERIFY2(b->isEnabled(), qPrintable(n + QStringLiteral(" disabled")));
    QMetaObject::invokeMethod(b, "clicked");
  }
  QString actionState(const QString& name) const {
    auto* a = static_cast<ActionTracker*>(shell->actions());
    for (int i = 0; i < a->count(); ++i)
      if (a->at(i).get(QStringLiteral("name")).str() == name) return a->at(i).get(QStringLiteral("state")).str();
    return {};
  }
};

class FlowsTest : public QObject {
  Q_OBJECT
 private slots:
  void initTestCase() {
    prepareQmlEnvironment();
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    g_prev = qInstallMessageHandler(captureQml);
  }
  void cleanupTestCase() {
    // fixed QML must run warning-free through every flow (no undefined bindings, no failed loads)
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.mid(0, 10).join(QLatin1Char('\n'))));
  }

  void everyPageRendersFromTheGateway() {
    Harness h;
    QVERIFY(h.up());
    QCOMPARE(h.shell->userName(), QStringLiteral("alice"));
    // every request carried the scope fields; business calls only through workspace.forward
    for (const auto& r : h.gw->gw->requests()) {
      for (const char* k : {"requestId", "workspaceId", "clientEpoch", "sessionEpoch", "methodId", "params", "body"}) QVERIFY2(r.has(QString::fromLatin1(k)), k);
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspace.forward")) {
        for (const char* bad : {"url", "path", "method", "header", "headers", "principal", "socket", "userId", "executionUid"}) QVERIFY(!r.get(QStringLiteral("body")).has(QString::fromLatin1(bad)));
        QVERIFY(!r.get(QStringLiteral("idempotencyKey")).str().isEmpty());
      }
    }
    for (const QString& p : {QStringLiteral("home"), QStringLiteral("login"), QStringLiteral("workspaces"), QStringLiteral("tasks"), QStringLiteral("policies"), QStringLiteral("incidents"),
                             QStringLiteral("proposals"), QStringLiteral("diagnostics"), QStringLiteral("backup"), QStringLiteral("update"), QStringLiteral("hardware")}) {
      h.click(QStringLiteral("nav:") + p);
      QTRY_COMPARE(h.shell->currentPage(), p);
      QTest::qWait(250);
      QImage img = h.view->shot(QStringLiteral("page-") + p + QStringLiteral(".png"));
      QVERIFY2(imageLooksRendered(img), qPrintable(p));
    }
    // hardware without a backend capability says so instead of pretending
    bool unavailableShown = false;
    for (QQuickItem* t : itemsOfClass(h.view->root(), "QQuickText"))
      if (reallyVisible(t) && t->property("text").toString().startsWith(QString::fromUtf8("不可用"))) unavailableShown = true;
    QVERIFY(unavailableShown);
    // home canvas: expand a code app; it renders inside its card
    h.click(QStringLiteral("nav:home"));
    h.shell->expandCard(h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str(), true);
    QTRY_VERIFY_WITH_TIMEOUT(itemsOfClass(h.view->root(), "QQuickTextField").size() >= 2, 5000);
    QTest::qWait(300);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-home-expanded.png"))));
    h.shell->openApp(QStringLiteral("rec-app"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("app"));
    QTest::qWait(300);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-app-records.png"))));
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.join(QLatin1Char('\n'))));
  }

  void canvasLayoutKeepsOnlyPositionsAndPrefs() {
    Harness h;
    QVERIFY(h.up());
    auto* c = static_cast<CanvasModel*>(h.shell->canvas());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    QVERIFY(c->setExpanded(kan, true));
    c->move(kan, 2, 1);
    c->setPinned(kan, true);
    h.shell->saveLayout();
    QFile f(h.shell->layoutFile());
    QVERIFY(f.open(QIODevice::ReadOnly));
    JValue saved = parseJsonOrThrow(f.readAll());
    QStringList top = saved.keys();
    top.sort();
    QCOMPARE(top, (QStringList{QStringLiteral("cards"), QStringLiteral("prefsVersion")}));
    for (const auto& card : saved.get(QStringLiteral("cards")).items()) {
      QStringList k = card.keys();
      k.sort();
      QCOMPARE(k, (QStringList{QStringLiteral("appId"), QStringLiteral("h"), QStringLiteral("prefs"), QStringLiteral("w"), QStringLiteral("x"), QStringLiteral("y")}));
      QStringList pk = card.get(QStringLiteral("prefs")).keys();
      pk.sort();
      QCOMPARE(pk, (QStringList{QStringLiteral("expanded"), QStringLiteral("pinned")}));
    }
    QVERIFY(!saved.stringify().contains(QString::fromUtf8("待办")));  // no app titles/content
    // at most 4 expanded at once; further expansions are refused (the pinned, expanded card stays and counts)
    QList<QPair<QString, QString>> apps;
    for (int i = 0; i < 6; ++i) apps << qMakePair(QStringLiteral("app-%1").arg(i), QStringLiteral("t"));
    c->setApps(apps);
    QCOMPARE(c->expandedCount(), 1);
    int ok = 0;
    for (int i = 0; i < 6; ++i) ok += c->setExpanded(QStringLiteral("app-%1").arg(i), true) ? 1 : 0;
    QCOMPARE(ok, 3);
    QCOMPARE(c->expandedCount(), CanvasModel::kMaxExpanded);
    // restore from disk
    CanvasModel back;
    QVERIFY(back.load(h.shell->layoutFile()));
    QCOMPARE(back.cards().front().appId, kan);
  }

  void dailyActionsReachReconciledState() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:tasks"));
    QTRY_VERIFY(h.find(QStringLiteral("cancelRun")) && h.find(QStringLiteral("cancelRun"))->isEnabled());
    h.click(QStringLiteral("cancelRun"));
    QTRY_COMPARE_WITH_TIMEOUT(h.actionState(QStringLiteral("runs.cancel")), QStringLiteral("reconciled"), 5000);
    QCOMPARE(h.sent(QStringLiteral("runs.cancel.post")).size(), 1);
    QVERIFY(h.sent(QStringLiteral("runs.get")).size() >= 1);  // reconciled from the authoritative status
    h.click(QStringLiteral("compact"));
    QTRY_COMPARE(h.actionState(QStringLiteral("conversation.compact")), QStringLiteral("reconciled"));
    h.click(QStringLiteral("nav:policies"));
    QTRY_VERIFY(h.find(QStringLiteral("maintToggle")));
    h.click(QStringLiteral("maintToggle"));
    QTRY_COMPARE(h.actionState(QStringLiteral("maintenance.pause")), QStringLiteral("reconciled"));
    QTRY_COMPARE(h.shell->maintenanceState().value(QStringLiteral("state")).toString(), QStringLiteral("paused"));
    h.click(QStringLiteral("nav:proposals"));
    QTRY_VERIFY(h.find(QStringLiteral("acceptProposal")));
    h.click(QStringLiteral("acceptProposal"));
    QTRY_COMPARE(h.actionState(QStringLiteral("proposal.accept")), QStringLiteral("reconciled"));
    QCOMPARE(h.sent(QStringLiteral("proposals.accept.post")).first().get(QStringLiteral("body")).get(QStringLiteral("body")).get(QStringLiteral("proposalHash")).str(), QStringLiteral("sha256:") + QString(64, QLatin1Char('f')));
    h.shell->act(QStringLiteral("app.archive"), {{QStringLiteral("appId"), QStringLiteral("rec-app")}, {QStringLiteral("appEpoch"), 3}});
    h.shell->act(QStringLiteral("app.restore"), {{QStringLiteral("appId"), QStringLiteral("rec-app")}});
    QTRY_COMPARE(h.actionState(QStringLiteral("app.archive")), QStringLiteral("reconciled"));
    QTRY_COMPARE(h.actionState(QStringLiteral("app.restore")), QStringLiteral("reconciled"));
    // each write had its own idempotency key
    QSet<QString> keys;
    for (const char* r : {"runs.cancel.post", "maintenance.control.post", "proposals.accept.post", "apps.archive.post", "apps.restore.post", "conversations.compactions.post"})
      for (const auto& x : h.sent(QString::fromLatin1(r))) keys.insert(x.get(QStringLiteral("idempotencyKey")).str());
    QCOMPARE(keys.size(), 6);
  }

  void machinePlanGoesThroughTrustedConfirmation() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:hardware"));
    h.shell->hardware(QStringLiteral("audio.volume.set"), {{QStringLiteral("percent"), 40}});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const QVariantMap c = h.shell->confirm();
    QCOMPARE(c.value(QStringLiteral("planHash")).toString(), QStringLiteral("sha256:") + QString(64, QLatin1Char('2')));
    QVERIFY(c.value(QStringLiteral("user")).toString().contains(QStringLiteral("alice")));
    QCOMPARE(c.value(QStringLiteral("workspace")).toString(), QString::fromUtf8("家庭"));
    QCOMPARE(c.value(QStringLiteral("version")).toString(), QStringLiteral("generation 7"));
    QVERIFY(!c.value(QStringLiteral("permissionChange")).toString().isEmpty());
    QVERIFY(!c.value(QStringLiteral("unknownNote")).toString().isEmpty());
    QCOMPARE(h.actionState(QStringLiteral("machine.plan")), QStringLiteral("needs_confirmation"));
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 0);  // nothing runs before the user confirms
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("trusted-confirm-machine.png"))));
    h.click(QStringLiteral("confirmAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 1);
    const JValue conf = h.sent(QStringLiteral("machine.actions.confirm")).first();
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("planHash")).str(), c.value(QStringLiteral("planHash")).toString());
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("ticket")).str(), QStringLiteral("ticket-1"));
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("reconciled"));
    // display change: 15 s revert window
    h.shell->hardware(QStringLiteral("display.mode.set"), {{QStringLiteral("output"), QStringLiteral("Virtual-1")}, {QStringLiteral("mode"), QStringLiteral("1920x1080")}, {QStringLiteral("scale"), 1}});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body")).get(QStringLiteral("params")).get(QStringLiteral("revertAfterSeconds")).toNumber(), 15.0);
    h.shell->confirmAccept();
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->displayRevertLeft() > 0, 5000);
    QVERIFY(h.shell->displayRevertLeft() <= 15);
    h.shell->keepDisplay();
    QCOMPARE(h.shell->displayRevertLeft(), 0);
    // a confirmation shown under an older session epoch is never sent
    h.shell->hardware(QStringLiteral("audio.mute.set"), {{QStringLiteral("muted"), true}});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const int confirmsBefore = h.sent(QStringLiteral("machine.actions.confirm")).size();
    h.be.sessionEpoch = 2;
    h.shell->applyStatusForTest(JValue::object({{QStringLiteral("sessionEpoch"), 2}, {QStringLiteral("locked"), false}}));
    QVERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QTest::qWait(200);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), confirmsBefore);
    // the gateway refusing a stale plan: shown as failed, no automatic re-plan
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->sessionBound() && !h.shell->locked(), 5000);
    h.be.planStale = true;
    const int plansBefore = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.shell->hardware(QStringLiteral("audio.volume.set"), {{QStringLiteral("percent"), 10}});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    h.shell->confirmAccept();
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("failed"));
    QTest::qWait(300);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plansBefore + 1);
  }

  void wifiKeyTravelsOnlyInTheSecretFieldOfOnePlan() {
    // V1-I11: the Wi-Fi key is in the plan request's `secret` field only — not in params, not in what the Shell keeps
    Harness h;
    QVERIFY(h.up());
    const int before = h.sent(QStringLiteral("machine.actions.plan")).size();
    const QString key = QStringLiteral("wifi-key-7f3a91");
    h.shell->hardwareSecret(QStringLiteral("network.wifi.connect"), {{QStringLiteral("device"), QStringLiteral("wlan0")}, {QStringLiteral("ssid"), QStringLiteral("lab")}}, key);
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), before + 1);
    const JValue req = h.sent(QStringLiteral("machine.actions.plan")).last();
    QCOMPARE(req.get(QStringLiteral("body")).get(QStringLiteral("secret")).str(), key);
    QCOMPARE(req.get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str(), QStringLiteral("network.wifi.connect"));
    QVERIFY(!req.get(QStringLiteral("body")).get(QStringLiteral("params")).stringify().contains(key));
    QVERIFY(!h.shell->lastPlanSentForTest().contains(key));
    // a retry of the same action never re-sends the key (it was not kept)
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    for (const auto& v : h.shell->confirm()) QVERIFY(!v.toString().contains(key));
    h.shell->confirmReject();
    // a plain hardware() call carries no secret field
    h.shell->hardware(QStringLiteral("network.wifi.disconnect"), {{QStringLiteral("device"), QStringLiteral("wlan0")}});
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), before + 2);
    QVERIFY(h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body")).get(QStringLiteral("secret")).isNullish());
  }

  void systemActionButtonOnlyRequestsAPlan() {
    Harness h;
    QVERIFY(h.up());
    const QString consoleId = h.be.console.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(consoleId));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(vm->runtime().render().stringify().contains(QStringLiteral("SystemActionButton")));
    // replay the console scenario's valid click: the button's command input comes from its form
    JValue steps = h.be.console.get(QStringLiteral("steps"));
    QString path;
    for (const auto& st : steps.items()) {
      if (st.get(QStringLiteral("op")).str() == QLatin1String("type")) vm->typeText(st.get(QStringLiteral("formId")).str(), st.get(QStringLiteral("name")).str(), st.get(QStringLiteral("raw")).str());
      if (st.get(QStringLiteral("op")).str() == QLatin1String("click") && st.get(QStringLiteral("expect")).get(QStringLiteral("result")).get(QStringLiteral("kind")).str() == QLatin1String("request")) {
        path = st.get(QStringLiteral("path")).str();
        break;
      }
    }
    QVERIFY(!path.isEmpty());
    vm->click(path);
    QTRY_COMPARE(h.sent(QStringLiteral("apps.systemactions.post")).size(), 1);
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 0);
    QCOMPARE(h.shell->confirm().value(QStringLiteral("planHash")).toString(), QStringLiteral("sha256:") + QString(64, QLatin1Char('9')));
    h.shell->confirmAccept();
    QTRY_COMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 1);
    QCOMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).first().get(QStringLiteral("body")).get(QStringLiteral("body")).get(QStringLiteral("planHash")).str(), QStringLiteral("sha256:") + QString(64, QLatin1Char('9')));
  }

  void lockClearsSensitiveStateEverywhere() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    JValue steps = h.be.kanban.get(QStringLiteral("steps"));
    for (const auto& st : steps.items())
      if (st.get(QStringLiteral("op")).str() == QLatin1String("type")) {
        vm->typeText(st.get(QStringLiteral("formId")).str(), st.get(QStringLiteral("name")).str(), QStringLiteral("我的银行卡密码"));
        break;
      }
    QVERIFY(vm->runtime().formsSnapshot().stringify().contains(QString::fromUtf8("银行卡")));
    h.shell->setIntentDraft(QString::fromUtf8("帮我记住密码"));
    QGuiApplication::clipboard()->setText(QStringLiteral("copied secret"));
    h.be.locked = true;
    h.be.sessionEpoch = 5;
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->locked(), 8000);  // picked up from session.status (sessionEpoch change)
    QVERIFY(!vm->runtime().formsSnapshot().stringify().contains(QString::fromUtf8("银行卡")));
    QVERIFY(h.shell->intentDraft().isEmpty());
    QVERIFY(QGuiApplication::clipboard()->text().isEmpty());
    QCOMPARE(static_cast<JsonListModel*>(h.shell->notifications())->count(), 0);
    QVERIFY(h.find(QStringLiteral("lockMask"))->isVisible());
    // locked: machine actions/member changes are refused locally
    const int plans = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.shell->hardware(QStringLiteral("power.reboot"), {});
    QTest::qWait(100);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plans);
    // unlock -> rebind
    h.be.locked = false;
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->locked(), 8000);
    QCOMPARE(h.shell->sessionEpoch(), qint64(5));
  }

  void workspaceSwitchDropsLateResponses() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    h.be.holdQueries = true;
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(h.sent(QStringLiteral("apps.queries.post")).size() >= 1);
    const QString heldId = h.sent(QStringLiteral("apps.queries.post")).last().get(QStringLiteral("requestId")).str();
    QPointer<AppViewModel> oldView(vm);
    const int dropped = h.shell->lateDropped();
    h.shell->switchWorkspace(WS_B);
    QTRY_COMPARE(h.shell->workspaceId(), WS_B);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() >= 2, 5000);
    // the held A-scope answer arrives after the switch: dropped, never applied to B
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, heldId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("output"), JValue::object()}, {QStringLiteral("revisionId"), QStringLiteral("x")}, {QStringLiteral("appEpoch"), 3}})));
    QTRY_VERIFY(h.shell->lateDropped() > dropped);
    QTRY_VERIFY(oldView.isNull());  // A's view (forms, selection, text caches) is gone
    // event subscription moved to B
    QTRY_VERIFY(([&] {
      for (const auto& r : h.sent(QStringLiteral("events.subscribe")))
        if (r.get(QStringLiteral("params")).get(QStringLiteral("workspaceId")).str() == WS_B) return true;
      return false;
    }()));
    // events for A are now ignored by the transport (unsubscribed)
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11), Q_ARG(QString, QStringLiteral("membership.revoked")), Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}})));
    QTest::qWait(200);
    QVERIFY(!h.shell->writesStopped());
  }

  // V1-W05: a fast A -> B -> A round trip. The answer held from the FIRST visit to A comes back while the Shell is
  // on A again: same workspaceId, but an older scope, so it is dropped and never shown in the new A view.
  void rapidRoundTripDropsAnswersFromTheEarlierVisit() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    h.be.holdQueries = true;
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(h.sent(QStringLiteral("apps.queries.post")).size() >= 1);
    const QString heldId = h.sent(QStringLiteral("apps.queries.post")).last().get(QStringLiteral("requestId")).str();
    QPointer<AppViewModel> firstView(vm);
    const int dropped = h.shell->lateDropped();
    const int attaches = h.sent(QStringLiteral("workspaces.attach")).size();
    h.shell->switchWorkspace(WS_B);
    h.shell->switchWorkspace(WS_A);  // back before B has even settled
    QTRY_COMPARE(h.shell->workspaceId(), WS_A);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() >= attaches + 2, 5000);
    QTRY_VERIFY(firstView.isNull());  // the first A view (forms, selection, caches) is gone
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, heldId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("output"), JValue::object({{QStringLiteral("marker"), QStringLiteral("FIRST-VISIT-BODY")}})}, {QStringLiteral("revisionId"), QStringLiteral("x")}, {QStringLiteral("appEpoch"), 3}})));
    QTRY_VERIFY(h.shell->lateDropped() > dropped);
    // whatever the new A view shows, it is not the first visit's answer
    if (auto* now = qobject_cast<AppViewModel*>(h.shell->appView(kan))) {
      QTest::qWait(200);
      QVERIFY(!now->runtime().formsSnapshot().stringify().contains(QStringLiteral("FIRST-VISIT-BODY")));
    }
    // the event subscription ends on A, not B
    QTRY_VERIFY(([&] {
      const auto subs = h.sent(QStringLiteral("events.subscribe"));
      return !subs.isEmpty() && subs.last().get(QStringLiteral("params")).get(QStringLiteral("workspaceId")).str() == WS_A;
    }()));
  }

  void degradedModes() {
    Harness h;
    QVERIFY(h.up());
    // model down: active apps keep running, intent submission disabled
    h.be.modelDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->modelAvailable(), 20000);
    QVERIFY(h.shell->act(QStringLiteral("runs.submit"), {{QStringLiteral("intent"), QStringLiteral("x")}}).isEmpty());
    QVERIFY(h.shell->canWrite(false));
    // broker down: plain CRUD still allowed, system actions refused
    h.be.brokerDown = true;
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->brokerAvailable(), 20000);
    QVERIFY(h.shell->canWrite(false));
    QVERIFY(!h.shell->canWrite(true));
    auto* rec = qobject_cast<AppViewModel*>(h.shell->appView(QStringLiteral("rec-app")));
    QTRY_COMPARE(rec->mode(), QStringLiteral("records"));
    rec->openCreate();
    rec->setDraft(QStringLiteral("title"), QString::fromUtf8("买牛奶"));
    rec->submitRecord();
    QTRY_COMPARE(h.sent(QStringLiteral("apps.records.post")).size(), 1);
    // Host down: read-only cache with its timestamp; submits refused locally
    h.be.hostDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->hostAvailable(), 20000);
    QVERIFY(h.shell->readOnly());
    QVERIFY(!h.shell->cachedAt().isEmpty());
    QVERIFY(h.shell->banner().contains(h.shell->cachedAt()));
    const int writes = h.sent(QStringLiteral("runs.cancel.post")).size();
    QVERIFY(h.shell->act(QStringLiteral("runs.cancel"), {{QStringLiteral("runId"), QStringLiteral("run-1")}}).isEmpty());
    QCOMPARE(h.sent(QStringLiteral("runs.cancel.post")).size(), writes);
    h.be.hostDown = false;
    h.be.modelDown = false;
    h.be.brokerDown = false;
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->hostAvailable() && h.shell->modelAvailable() && h.shell->brokerAvailable(), 20000);
    // gateway gone: disconnected banner + reconnect; comes back by itself
    QMetaObject::invokeMethod(h.gw->gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->rpc()->stats().reconnects >= 1, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->connected(), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("session.bind")).size() >= 2, 5000);
  }

  void eventGapTriggersSnapshotThenResubscribe() {
    Harness h;
    QVERIFY(h.up());
    QTRY_VERIFY(h.sent(QStringLiteral("events.subscribe")).size() >= 1);
    const int attaches = h.sent(QStringLiteral("workspaces.attach")).size();
    const int subs = h.sent(QStringLiteral("events.subscribe")).size();
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 15), Q_ARG(QString, QStringLiteral("operation.state_changed")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() > attaches, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("events.subscribe")).size() > subs, 5000);
    // order: the snapshot (attach) precedes the new subscription
    int lastAttach = -1, lastSub = -1, i = 0;
    for (const auto& r : h.gw->gw->requests()) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspaces.attach")) lastAttach = i;
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) lastSub = i;
      i++;
    }
    QVERIFY(lastAttach < lastSub);
    // membership revocation for me stops writes
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11), Q_ARG(QString, QStringLiteral("membership.revoking")), Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}})));
    QTRY_VERIFY(h.shell->writesStopped());
    QVERIFY(!h.shell->canWrite(false));
  }
};

QTEST_MAIN(FlowsTest)
#include "flows_test.moc"
