// agentos-shell-e2e: the native Shell (same ShellController, same fixed QML, offscreen) against the REAL session
// gateway, machined and workspace Host of a NixOS VM (spec §32 V1-D08, V1-M06, V1-O03). Never part of a release:
// built only with -DAGENTOS_E2E=ON for the VM check m13-native. Run inside a logind session of the user (the gateway
// binds sessions by peer credentials + logind), with QT_QPA_PLATFORM=offscreen.
//
//   AGENTOS_E2E_PHASE=mainline   declarative app → data CRUD/query → modify → version switch (data kept) → code app
//                                → system app, all through Shell actions and the app view (V1-M06 part 1)
//   AGENTOS_E2E_PHASE=daily      task cancel, session compaction, proposal accept, maintenance pause, app archive and
//                                restore from the pages' own buttons, each to its reconciled state (V1-D08, M06 part 2)
//   AGENTOS_E2E_PHASE=offline    model unreachable: generation refused with a visible reason, CRUD/query/version
//                                switch still work (V1-O03)
//   AGENTOS_E2E_PHASE=switch     real workspaces A and B (AGENTOS_E2E_WS_A/_B): a query in flight in A, then rapid
//                                A→B→A→B switching; B shows nothing of A (apps, record bodies), A still has it (V1-W05)
// Each step prints one line "E2E <step> <json>" so the VM script can check the Host's database against it.
#include "gui_support.hpp"
#include "json_list_model.hpp"

#include <QDateTime>
#include <QJsonDocument>
#include <QQuickStyle>
#include <cstdio>

using namespace agentos;
using namespace agentos::test;

namespace {

QString envOr(const char* k, const QString& d) {
  const QByteArray v = qgetenv(k);
  return v.isEmpty() ? d : QString::fromUtf8(v);
}

void report(const QString& step, const QVariantMap& v = {}) {
  QString line = QStringLiteral("E2E ") + step + QLatin1Char(' ') + JValue::fromVariant(v).stringify();
  std::printf("%s\n", line.toUtf8().constData());
  std::fflush(stdout);
}

struct Real {
  QTemporaryDir dir;
  std::unique_ptr<ShellController> shell;
  std::unique_ptr<View> view;
  Real() {
    shell = std::make_unique<ShellController>(envOr("AGENTOS_GATEWAY_SOCKET", QStringLiteral("/run/agentos/gateway.sock")));
    shell->setLayoutDir(dir.path());
    view = std::make_unique<View>(shell.get(), QSize(1280, 900));
  }
  bool up() {
    if (!view->load(QStringLiteral("ShellRoot.qml"))) return false;
    shell->start();
    const bool ok = QTest::qWaitFor([&] { return shell->sessionBound() && !shell->workspaceId().isEmpty() && shell->hostAvailable(); }, 60000);
    if (!ok)
      std::printf("E2E-DIAG connected=%d bound=%d user=%s workspace=%s workspaces=%d host=%d banner=%s\n", int(shell->connected()), int(shell->sessionBound()),
                  shell->userName().toUtf8().constData(), shell->workspaceId().toUtf8().constData(), static_cast<JsonListModel*>(shell->workspaces())->count(),
                  int(shell->hostAvailable()), shell->banner().toUtf8().constData());
    return ok;
  }
  JsonListModel* model(QObject* o) const { return static_cast<JsonListModel*>(o); }
  // every visible, enabled item with this objectName (rows repeat their buttons)
  QList<QQuickItem*> all(const QString& name) const {
    QList<QQuickItem*> out;
    walkItems(view->root(), [&](QQuickItem* i) {
      if (i->objectName() == name && reallyVisible(i)) out << i;
    });
    return out;
  }
  QQuickItem* byLabel(const QString& label) const {
    QQuickItem* hit = nullptr;
    walkItems(view->root(), [&](QQuickItem* i) {
      if (!hit && reallyVisible(i) && i->property("label").toString() == label && i->isEnabled()) hit = i;
    });
    return hit;
  }
  void press(QQuickItem* b) { QMetaObject::invokeMethod(b, "clicked"); }
  void go(const QString& page) {
    shell->setCurrentPage(page);
    shell->refreshPage();
    QTest::qWait(400);
  }
  JValue action(const QString& name) const {
    auto* a = static_cast<ActionTracker*>(shell->actions());
    JValue last;
    for (int i = 0; i < a->count(); ++i)
      if (a->at(i).get(QStringLiteral("name")).str() == name) last = a->at(i);
    return last;
  }
  QString actionState(const QString& name) const { return action(name).get(QStringLiteral("state")).stringOr(QString()); }
  int appCount() const { return model(shell->apps())->count(); }
  JValue app(int i) const { return model(shell->apps())->at(i); }
  JValue appById(const QString& id) const {
    for (int i = 0; i < appCount(); ++i)
      if (app(i).get(QStringLiteral("appId")).str() == id) return app(i);
    return JValue();
  }
  JValue run(const QString& id) const {
    auto* m = model(shell->runs());
    for (int i = 0; i < m->count(); ++i)
      if (m->at(i).get(QStringLiteral("runId")).str() == id) return m->at(i);
    return JValue();
  }
  QSet<QString> runIds() {
    go(QStringLiteral("tasks"));
    QTest::qWait(600);
    QSet<QString> ids;
    auto* m = model(shell->runs());
    for (int i = 0; i < m->count(); ++i) ids.insert(m->at(i).get(QStringLiteral("runId")).str());
    return ids;
  }
  // Submit an intent through the Home page's own field and button; returns the new runId (seen in the Task Center).
  QString submit(const QString& text, const QString& target = {}) {
    const QSet<QString> before = runIds();
    go(QStringLiteral("home"));
    shell->setIntentDraft(text);
    QQuickItem* f = findByObjectName(view->root(), QStringLiteral("intentInput"));
    QQuickItem* b = findByObjectName(view->root(), QStringLiteral("intentSubmit"));
    const bool viaButton = target.isEmpty() && f && b && b->isEnabled();
    if (viaButton) {
      f->setProperty("text", text);
      press(b);
    } else {
      shell->submitIntent(text, target);
    }
    QString runId;
    QTest::qWaitFor([&] {
      for (const QString& id : runIds())
        if (!before.contains(id)) runId = id;
      return !runId.isEmpty();
    }, 60000);
    if (runId.isEmpty())
      std::printf("E2E-DIAG submit: no new run; viaButton=%d model=%d readOnly=%d host=%d notice=%s draft=%s action=%s\n", int(viaButton), int(shell->modelAvailable()),
                  int(shell->readOnly()), int(shell->hostAvailable()), qPrintable(shell->notice()), qPrintable(shell->intentDraft()),
                  qPrintable(action(QStringLiteral("runs.submit")).stringify().left(800)));
    return runId;
  }
  // Wait until the Task Center shows the run in a final state; returns the final status.
  QString waitRun(const QString& runId, int ms) {
    QString st;
    QTest::qWaitFor([&] {
      go(QStringLiteral("tasks"));
      st = run(runId).get(QStringLiteral("status")).stringOr(QString());
      return st == QLatin1String("succeeded") || st == QLatin1String("failed") || st == QLatin1String("cancelled") || st == QLatin1String("rejected");
    }, ms);
    if (st != QLatin1String("succeeded") && st != QLatin1String("failed") && st != QLatin1String("cancelled") && st != QLatin1String("rejected")) {
      // diagnostics for a run the Task Center never saw finish: transport, session and list freshness
      auto* m = model(shell->runs());
      QStringList ts;
      const QVariantMap t = shell->transportStats();
      for (auto it = t.begin(); it != t.end(); ++it) ts << it.key() + QLatin1Char('=') + it.value().toString();
      fprintf(stderr, "E2E waitRun timeout run=%s status=%s connected=%d bound=%d host=%d banner=%s listCount=%d listUpdated=%s transport={%s} row=%s\n",
              qPrintable(runId), qPrintable(st), int(shell->connected()), int(shell->sessionBound()), int(shell->hostAvailable()), qPrintable(shell->banner()),
              m->count(), qPrintable(m->updatedAt()), qPrintable(ts.join(QLatin1Char(' '))), qPrintable(run(runId).stringify().left(600)));
    }
    return st;
  }
  QString newestRunId() const {
    auto* m = model(shell->runs());
    QString best, bestAt;
    for (int i = 0; i < m->count(); ++i) {
      const QString at = m->at(i).get(QStringLiteral("createdAt")).stringOr(QString());
      if (best.isEmpty() || at > bestAt) {
        best = m->at(i).get(QStringLiteral("runId")).str();
        bestAt = at;
      }
    }
    return best;
  }
};

AppViewModel* openView(Real& r, const QString& appId) {
  r.shell->openApp(appId);
  QTest::qWaitFor([&] { return r.shell->currentPage() == QLatin1String("app"); }, 5000);
  auto* v = qobject_cast<AppViewModel*>(r.shell->appView(appId));
  if (v) QTest::qWaitFor([&] { return v->mode() != QLatin1String("loading"); }, 20000);
  return v;
}

int rows(AppViewModel* v) { return v ? static_cast<RecordsModel*>(v->records())->rows() : -1; }

// what the user would see when a record write does not land: the view mode, the form state and the Shell's notice
QString writeDiag(Real& r, AppViewModel* v, int n, const QVariantMap& afterSubmit) {
  const auto js = [](const QVariant& x) { return QString::fromUtf8(QJsonDocument::fromVariant(x).toJson(QJsonDocument::Compact)); };
  return QStringLiteral("mode=%1 title=%2 n=%3 rows=%4 afterSubmit=%5 now=%6 notice=%7 banner=%8 transport=%9")
      .arg(v ? v->mode() : QStringLiteral("-"), v ? v->title() : QStringLiteral("-"))
      .arg(n)
      .arg(rows(v))
      .arg(js(afterSubmit), js(v ? v->recordState() : QVariantMap()), r.shell->notice(), r.shell->banner(), js(r.shell->transportStats()));
}

}  // namespace

class E2E : public QObject {
  Q_OBJECT
  QString phase = envOr("AGENTOS_E2E_PHASE", QStringLiteral("mainline"));

 private slots:
  void initTestCase() {
    prepareQmlEnvironment();
    QQuickStyle::setStyle(QStringLiteral("Basic"));
  }

  void mainline() {
    if (phase != QLatin1String("mainline")) QSKIP("phase");
    Real r;
    QVERIFY2(r.up(), "Shell did not bind a session on the real gateway");
    report(QStringLiteral("bound"), {{QStringLiteral("workspaceId"), r.shell->workspaceId()}, {QStringLiteral("user"), r.shell->userName()}, {QStringLiteral("model"), r.shell->modelAvailable()}});
    QTRY_VERIFY_WITH_TIMEOUT(r.shell->modelAvailable(), 30000);

    // 1. declarative app from an intent typed into the Home page
    QString run1 = r.submit(QStringLiteral("做一个待办应用"));
    QVERIFY2(!run1.isEmpty(), "runs.submit gave no runId");
    QCOMPARE(r.waitRun(run1, 240000), QStringLiteral("succeeded"));
    if (!QTest::qWaitFor([&] { return r.appCount() >= 1; }, 20000)) {
      r.go(QStringLiteral("home"));   // a page refresh re-reads the app list from the Host
      QTest::qWaitFor([&] { return r.appCount() >= 1; }, 10000);
      const QVariantMap t = r.shell->transportStats();
      QStringList ts;
      for (auto it = t.begin(); it != t.end(); ++it) ts << it.key() + QLatin1Char('=') + it.value().toString();
      fprintf(stderr, "E2E app list after the run: count=%d (events did not refresh it within 20 s) transport={%s}\n", r.appCount(), qPrintable(ts.join(QLatin1Char(' '))));
    }
    QVERIFY(r.appCount() >= 1);
    const QString todo = r.app(0).get(QStringLiteral("appId")).str();
    report(QStringLiteral("declarative"), {{QStringLiteral("runId"), run1}, {QStringLiteral("appId"), todo}});

    // 2. data: create two records through the record form, query by search
    AppViewModel* v = openView(r, todo);
    QVERIFY(v);
    QCOMPARE(v->mode(), QStringLiteral("records"));
    for (const QString& t : {QStringLiteral("买牛奶"), QStringLiteral("写周报")}) {
      v->openCreate();
      v->setDraft(QStringLiteral("title"), t);
      v->submitRecord();
      QTest::qWait(300);
    }
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 2, 20000);
    v->setSearch(QStringLiteral("周报"));
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
    v->setSearch(QString());
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 2, 20000);
    // update the first record (mark done) through the edit form
    v->openEdit(0);
    v->setDraft(QStringLiteral("done"), true);
    v->submitRecord();
    QTest::qWait(500);
    QVERIFY(imageLooksRendered(r.view->shot(QStringLiteral("e2e-todo.png"))));
    report(QStringLiteral("crud"), {{QStringLiteral("rows"), rows(v)}});

    // 3. modify the app: priority + filter; the active version changes, data stays
    const double epoch1 = r.appById(todo).get(QStringLiteral("appEpoch")).toVariant().toDouble();
    QString run2 = r.submit(QStringLiteral("增加优先级和筛选"), todo);
    QVERIFY(!run2.isEmpty());
    QCOMPARE(r.waitRun(run2, 240000), QStringLiteral("succeeded"));
    r.go(QStringLiteral("home"));
    QTRY_VERIFY_WITH_TIMEOUT(r.appById(todo).get(QStringLiteral("appEpoch")).toVariant().toDouble() > epoch1, 20000);
    v = openView(r, todo);
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 2, 20000);
    QVERIFY2(v->filterFields().size() >= 2 || r.appById(todo).get(QStringLiteral("title")).str().contains(QStringLiteral("优先级")), "the new version has no priority filter");
    report(QStringLiteral("modified"), {{QStringLiteral("runId"), run2}, {QStringLiteral("epoch"), r.appById(todo).get(QStringLiteral("appEpoch")).toVariant()}});

    // 4. switch back to the first version from the app detail page; records survive
    r.go(QStringLiteral("app"));
    QTRY_VERIFY_WITH_TIMEOUT(r.model(r.shell->revisions())->count() >= 2, 20000);
    QQuickItem* sw = r.byLabel(QStringLiteral("切换到此版本"));
    QVERIFY2(sw, "no enabled version switch button");
    r.press(sw);
    QTest::qWaitFor([&] { const QString st = r.actionState(QStringLiteral("app.deploy")); return st == QLatin1String("reconciled") || st == QLatin1String("failed") || st == QLatin1String("unknown"); }, 120000);
    report(QStringLiteral("deploy"), {{QStringLiteral("state"), r.actionState(QStringLiteral("app.deploy"))}, {QStringLiteral("action"), r.action(QStringLiteral("app.deploy")).toVariant()}});
    QCOMPARE(r.actionState(QStringLiteral("app.deploy")), QStringLiteral("reconciled"));
    v = openView(r, todo);
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 2, 20000);
    report(QStringLiteral("switched"), {{QStringLiteral("rows"), rows(v)}});

    // 5. code app (isolated runtime, release images) and 6. system app, both from intents
    QString run3 = r.submit(QStringLiteral("做一个看板应用"));
    QCOMPARE(r.waitRun(run3, 420000), QStringLiteral("succeeded"));
    r.go(QStringLiteral("home"));
    QTRY_VERIFY_WITH_TIMEOUT(r.appCount() >= 2, 20000);
    QString kanban;
    for (int i = 0; i < r.appCount(); ++i)
      if (r.app(i).get(QStringLiteral("appId")).str() != todo) kanban = r.app(i).get(QStringLiteral("appId")).str();
    r.shell->expandCard(kanban, true);
    QTest::qWait(1500);
    QVERIFY(imageLooksRendered(r.view->shot(QStringLiteral("e2e-kanban.png"))));
    report(QStringLiteral("code"), {{QStringLiteral("runId"), run3}, {QStringLiteral("appId"), kanban}});

    QString run4 = r.submit(QStringLiteral("做一个系统控制台"));
    const QString st4 = r.waitRun(run4, 420000);
    report(QStringLiteral("system"), {{QStringLiteral("runId"), run4}, {QStringLiteral("status"), st4}});
    QCOMPARE(st4, QStringLiteral("succeeded"));
  }

  void daily() {
    if (phase != QLatin1String("daily")) QSKIP("phase");
    Real r;
    QVERIFY(r.up());
    // task cancel: a slow run is accepted, then cancelled from the Task Center's own button
    const QString slow = r.submit(QStringLiteral("[faux:slow:90000] 做一个笔记应用"));
    QVERIFY(!slow.isEmpty());
    r.go(QStringLiteral("tasks"));
    QQuickItem* cancel = nullptr;
    QTest::qWaitFor([&] {
      r.go(QStringLiteral("tasks"));
      for (QQuickItem* b : r.all(QStringLiteral("cancelRun")))   // this run's own row: other runs (background) may be running too
        if (b->isEnabled() && b->property("runId").toString() == slow) cancel = b;
      return cancel != nullptr;
    }, 30000);
    QVERIFY2(cancel, "no enabled cancel button for the running task");
    r.press(cancel);
    // (run 41140419617: reconciled after 87.5 s — the faux slow step was not abortable; it is now, the bound stays generous)
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("runs.cancel")), QStringLiteral("reconciled"), 150000);
    QCOMPARE(r.waitRun(slow, 120000), QStringLiteral("cancelled"));
    report(QStringLiteral("cancel"), {{QStringLiteral("runId"), slow}});

    // session compaction from the Task Center
    r.go(QStringLiteral("tasks"));
    QList<QQuickItem*> compact = r.all(QStringLiteral("compact"));
    QVERIFY2(!compact.isEmpty(), "no compact button");
    r.press(compact.first());
    QTRY_VERIFY_WITH_TIMEOUT(r.actionState(QStringLiteral("conversation.compact")) == QLatin1String("reconciled") || r.actionState(QStringLiteral("conversation.compact")) == QLatin1String("failed"), 120000);
    report(QStringLiteral("compact"), {{QStringLiteral("state"), r.actionState(QStringLiteral("conversation.compact"))}, {QStringLiteral("action"), r.action(QStringLiteral("conversation.compact")).toVariant()}});
    QCOMPARE(r.actionState(QStringLiteral("conversation.compact")), QStringLiteral("reconciled"));

    // proposal accept (the VM script started an optimisation check; its candidate waits as a pending proposal)
    QQuickItem* acc = nullptr;
    QTest::qWaitFor([&] {
      r.go(QStringLiteral("proposals"));
      for (QQuickItem* b : r.all(QStringLiteral("acceptProposal")))
        if (b->isEnabled()) acc = b;
      return acc != nullptr;
    }, 300000);
    QVERIFY2(acc, "no acceptable proposal on the Proposals page");
    r.press(acc);
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("proposal.accept")), QStringLiteral("reconciled"), 240000);
    report(QStringLiteral("proposal"), {{QStringLiteral("action"), r.action(QStringLiteral("proposal.accept")).toVariant()}});

    // maintenance pause from the Policies page
    r.go(QStringLiteral("policies"));
    QQuickItem* mt = nullptr;
    QTest::qWaitFor([&] { mt = findByObjectName(r.view->root(), QStringLiteral("maintToggle")); return mt && reallyVisible(mt); }, 20000);
    QVERIFY(mt);
    r.press(mt);
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("maintenance.pause")), QStringLiteral("reconciled"), 60000);
    QTRY_VERIFY_WITH_TIMEOUT((r.go(QStringLiteral("policies")), r.shell->maintenanceState().value(QStringLiteral("state")).toString() == QLatin1String("paused")), 30000);
    report(QStringLiteral("maintenance"), {{QStringLiteral("state"), r.shell->maintenanceState()}});

    // archive and restore an app from the app detail page
    r.go(QStringLiteral("home"));
    QTRY_VERIFY_WITH_TIMEOUT(r.appCount() >= 1, 20000);
    const QString appId = r.app(0).get(QStringLiteral("appId")).str();
    openView(r, appId);
    r.go(QStringLiteral("app"));
    QQuickItem* ar = r.byLabel(QStringLiteral("归档此应用"));
    QVERIFY(ar);
    r.press(ar);
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("app.archive")), QStringLiteral("reconciled"), 60000);
    QQuickItem* rs = r.byLabel(QStringLiteral("恢复此应用"));
    QVERIFY(rs);
    r.press(rs);
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("app.restore")), QStringLiteral("reconciled"), 60000);
    report(QStringLiteral("archive"), {{QStringLiteral("appId"), appId}});
  }

  void offline() {
    if (phase != QLatin1String("offline")) QSKIP("phase");
    Real r;
    QVERIFY(r.up());
    // the switching phase may have left B as the last workspace: work on A explicitly
    const QString wsA = envOr("AGENTOS_E2E_WS_A", QString());
    if (!wsA.isEmpty() && r.shell->workspaceId() != wsA) {
      r.shell->switchWorkspace(wsA);
      QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == wsA && r.shell->hostAvailable(), 60000);
    }
    // generation is visibly unavailable: the submit button is disabled and an attempt is refused before any run
    r.go(QStringLiteral("home"));
    QTRY_VERIFY_WITH_TIMEOUT(!r.shell->modelAvailable(), 30000);
    QQuickItem* b = findByObjectName(r.view->root(), QStringLiteral("intentSubmit"));
    QVERIFY(b && !b->isEnabled());
    const int runsBefore = r.model(r.shell->runs())->count();
    r.shell->submitIntent(QStringLiteral("做一个记账应用"), QString());
    QTest::qWait(1500);
    r.go(QStringLiteral("home"));
    QCOMPARE(r.model(r.shell->runs())->count(), runsBefore);
    report(QStringLiteral("generation"), {{QStringLiteral("modelAvailable"), r.shell->modelAvailable()}, {QStringLiteral("notice"), r.shell->notice()}, {QStringLiteral("banner"), r.shell->banner()}});
    // CRUD + query on the declarative to-do app generated earlier ("待办清单"). The code app "待办看板" also has 待办 in
    // its title but takes writes only through its own commands (records POST answers FORBIDDEN 403), and the app list
    // order changes after the daily archive/restore, so a plain "contains 待办" match picked it in runs 41145058422/41146819604.
    QTRY_VERIFY_WITH_TIMEOUT(r.appCount() >= 1, 20000);
    QString todo;
    for (int i = 0; i < r.appCount(); ++i)
      if (r.app(i).get(QStringLiteral("title")).str().startsWith(QStringLiteral("待办清单"))) todo = r.app(i).get(QStringLiteral("appId")).str();
    QVERIFY(!todo.isEmpty());
    AppViewModel* v = openView(r, todo);
    QVERIFY(v);
    const int n = rows(v);
    v->openCreate();
    v->setDraft(QStringLiteral("title"), QStringLiteral("断网也能记"));
    v->submitRecord();
    // the Shell's notice names the refusal if the write fails (m13 run 41145058422: POST records answered 403)
    QTRY_VERIFY2_WITH_TIMEOUT(rows(v) == n + 1, qPrintable(QStringLiteral("notice: ") + r.shell->notice() + QStringLiteral(" banner: ") + r.shell->banner()), 20000);
    v->setSearch(QStringLiteral("断网"));
    QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
    v->setSearch(QString());
    report(QStringLiteral("crud"), {{QStringLiteral("rows"), rows(v)}});
    // version switch still works without a model
    r.go(QStringLiteral("app"));
    QTRY_VERIFY_WITH_TIMEOUT(r.model(r.shell->revisions())->count() >= 2, 20000);
    QQuickItem* sw = r.byLabel(QStringLiteral("切换到此版本"));
    QVERIFY(sw);
    r.press(sw);
    QTRY_COMPARE_WITH_TIMEOUT(r.actionState(QStringLiteral("app.deploy")), QStringLiteral("reconciled"), 120000);
    report(QStringLiteral("version"), {});
  }
  void switching() {
    if (phase != QLatin1String("switch")) QSKIP("phase");
    const QString wsA = envOr("AGENTOS_E2E_WS_A", QString()), wsB = envOr("AGENTOS_E2E_WS_B", QString());
    QVERIFY(!wsA.isEmpty() && !wsB.isEmpty());
    Real r;
    QVERIFY(r.up());
    r.shell->switchWorkspace(wsA);
    QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == wsA && r.shell->hostAvailable(), 60000);
    r.go(QStringLiteral("home"));
    QTRY_VERIFY_WITH_TIMEOUT(r.appCount() >= 1, 30000);
    QSet<QString> appsA;
    QString todo;
    for (int i = 0; i < r.appCount(); ++i) {
      appsA.insert(r.app(i).get(QStringLiteral("appId")).str());
      if (r.app(i).get(QStringLiteral("title")).str().startsWith(QStringLiteral("待办清单"))) todo = r.app(i).get(QStringLiteral("appId")).str();
    }
    QVERIFY(!todo.isEmpty());
    const QString marker = QStringLiteral("A-ONLY-") + QString::number(QDateTime::currentMSecsSinceEpoch());
    AppViewModel* v = openView(r, todo);
    QVERIFY(v);
    QVERIFY2(v->mode() == QLatin1String("records"), qPrintable(writeDiag(r, v, -1, {})));
    // the first page has arrived before we count (rows == total, or a full page)
    QTRY_VERIFY2_WITH_TIMEOUT(rows(v) > 0 && (rows(v) == v->recordState().value(QStringLiteral("total")).toInt() || rows(v) >= 20), qPrintable(writeDiag(r, v, -1, {})), 20000);
    const int n = rows(v);
    v->openCreate();
    v->setDraft(QStringLiteral("title"), marker);
    v->submitRecord();
    const QVariantMap afterSubmit = v->recordState();
    QTRY_VERIFY2_WITH_TIMEOUT(rows(v) == n + 1, qPrintable(writeDiag(r, v, n, afterSubmit)), 20000);
    auto textHas = [&](const QString& needle) {
      bool hit = false;
      walkItems(r.view->root(), [&](QQuickItem* i) {
        if (reallyVisible(i) && i->property("text").toString().contains(needle)) hit = true;
      });
      return hit;
    };
    QTRY_VERIFY_WITH_TIMEOUT(textHas(marker), 10000);  // A's view really shows the body we look for later
    const int dropped0 = r.shell->lateDropped();
    // a query in flight in A, then switch away and back and away again without waiting for anything
    v->setSearch(marker.left(6));
    r.shell->switchWorkspace(wsB);
    r.shell->switchWorkspace(wsA);
    r.shell->switchWorkspace(wsB);
    QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == wsB && r.shell->hostAvailable(), 60000);
    QTest::qWait(3000);  // let every answer of the earlier visits arrive
    r.go(QStringLiteral("home"));
    QTest::qWait(1000);
    QStringList leaked;
    for (int i = 0; i < r.appCount(); ++i)
      if (appsA.contains(r.app(i).get(QStringLiteral("appId")).str())) leaked << r.app(i).get(QStringLiteral("appId")).str();
    QVERIFY2(leaked.isEmpty(), qPrintable(leaked.join(',')));
    QVERIFY2(!textHas(marker), "A's record body is visible in workspace B");
    QVERIFY(!textHas(QStringLiteral("A-ONLY-")));
    for (const QString& page : {QStringLiteral("tasks"), QStringLiteral("proposals"), QStringLiteral("policies")}) {
      r.go(page);
      QVERIFY2(!textHas(marker), qPrintable(page));
    }
    const int bApps = r.appCount();
    const int dropped = r.shell->lateDropped() - dropped0;
    // back in A the record is there: the check above looked for something that exists
    r.shell->switchWorkspace(wsA);
    QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == wsA && r.shell->hostAvailable(), 60000);
    AppViewModel* v2 = openView(r, todo);
    QVERIFY(v2);
    v2->setSearch(marker);
    QTRY_VERIFY_WITH_TIMEOUT(rows(v2) == 1, 20000);
    report(QStringLiteral("switch"), {{QStringLiteral("workspaceA"), wsA}, {QStringLiteral("workspaceB"), wsB}, {QStringLiteral("appsInB"), bApps},
                                      {QStringLiteral("lateDropped"), dropped}, {QStringLiteral("marker"), marker}});
  }
};

QTEST_MAIN(E2E)
#include "e2e_test.moc"
