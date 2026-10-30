// Offscreen render smoke, plain-text/injection, accessibility, List instance budget, charts, keyboard, IME preedit,
// trusted confirmation layer (spec §10, §11; V1-D03/05/06/07/10). QT_QPA_PLATFORM=offscreen, software Qt Quick.
#include "chart_item.hpp"
#include "gui_support.hpp"
#include "ime_guard.hpp"

#include <QClipboard>
#include <QGuiApplication>
#include <QQuickStyle>
#include <QTemporaryDir>

using namespace agentos;
using namespace agentos::test;

static JValue detailFor(const JValue& bundle, const JValue& app) {
  return JValue::object({{QStringLiteral("appId"), app.get(QStringLiteral("appId"))},
                         {QStringLiteral("appEpoch"), app.get(QStringLiteral("appEpoch"))},
                         {QStringLiteral("activeRevisionId"), app.get(QStringLiteral("revisionId"))},
                         {QStringLiteral("bundle"), bundle}});
}

/** An app view filled with the data the scenario vector loads first. */
static AppViewModel* scenarioView(const QString& file, QObject* parent) {
  JValue sc = loadFixture(QStringLiteral("v1.0/slot-vectors/") + file);
  auto* vm = new AppViewModel(sc.get(QStringLiteral("app")).get(QStringLiteral("appId")).str(), nullptr, parent);
  vm->setDetail(detailFor(sc.get(QStringLiteral("bundle")), sc.get(QStringLiteral("app"))));
  for (const auto& st : sc.get(QStringLiteral("steps")).items())
    if (st.get(QStringLiteral("op")).str() == QLatin1String("load") && st.get(QStringLiteral("expect")).get(QStringLiteral("result")).toBool())
      vm->applySource(st.get(QStringLiteral("source")).str(), decodeMissing(st.get(QStringLiteral("output"))));
  return vm;
}

class GuiTest : public QObject {
  Q_OBJECT
  ShellController* shell = nullptr;
  QTemporaryDir dir;

 private slots:
  void initTestCase() {
    prepareQmlEnvironment();
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    shell = new ShellController(dir.path() + QStringLiteral("/none.sock"), this);
    shell->setLayoutDir(dir.path());
  }

  void renderEveryFixture_data() {
    QTest::addColumn<QString>("file");
    for (const QString& f : QDir(QString::fromUtf8(AGENTOS_FIXTURES) + QStringLiteral("/v1.0/slot-vectors")).entryList({QStringLiteral("scenario-*.json")})) QTest::newRow(qPrintable(f)) << f;
  }
  void renderEveryFixture() {
    QFETCH(QString, file);
    auto* vm = scenarioView(file, this);
    QCOMPARE(vm->mode(), QStringLiteral("slot"));
    View v(shell, {1100, 1400});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(vm)}}));
    QImage img = v.shot(QString(file).replace(QStringLiteral(".json"), QStringLiteral(".png")));
    int colors = 0;
    double ink = 0;
    QVERIFY2(imageLooksRendered(img, &colors, &ink), qPrintable(QStringLiteral("blank render: colors=%1 ink=%2 size=%3x%4 root=%5x%6").arg(colors).arg(ink).arg(img.width()).arg(img.height()).arg(v.root()->width()).arg(v.root()->height())));
    // Every visible snapshot text reached the screen as a Text item.
    QStringList shown;
    for (QQuickItem* t : itemsOfClass(v.root(), "QQuickText"))
      if (reallyVisible(t)) shown << t->property("text").toString();
    QVERIFY(shown.join(QLatin1Char('\n')).contains(vm->title()));
    QCOMPARE(v.guard->blocked, 0);
  }

  void renderRecordsAndUnsupported() {
    // formatVersion 1 records app: native table/search/filter/form
    JValue b1 = loadFixture(QStringLiteral("todo-v2.json"));
    auto* rec = new AppViewModel(b1.get(QStringLiteral("manifest")).get(QStringLiteral("appId")).str(), nullptr, this);
    rec->setDetail(JValue::object({{QStringLiteral("appId"), b1.get(QStringLiteral("manifest")).get(QStringLiteral("appId"))}, {QStringLiteral("appEpoch"), 2}, {QStringLiteral("activeRevisionId"), QStringLiteral("r1")}, {QStringLiteral("bundle"), b1}}));
    QCOMPARE(rec->mode(), QStringLiteral("records"));
    rec->openCreate();
    View v(shell);
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(rec)}}));
    QVERIFY(imageLooksRendered(v.shot(QStringLiteral("records-todo-v2.png"))));
    QVERIFY(rec->recordForm().size() == 3);  // title, done, priority with their default rules
    // unknown format / invalid tree -> error card + version switch entry, not a blank canvas
    JValue bad = loadFixture(QStringLiteral("v0.2/todo-kanban/bundle.json"));
    bad.set(QStringLiteral("formatVersion"), 9);
    auto* unk = new AppViewModel(QStringLiteral("unknown-app"), nullptr, this);
    unk->setDetail(JValue::object({{QStringLiteral("appId"), QStringLiteral("unknown-app")}, {QStringLiteral("appEpoch"), 1}, {QStringLiteral("activeRevisionId"), QStringLiteral("x")}, {QStringLiteral("bundle"), bad}}));
    QCOMPARE(unk->mode(), QStringLiteral("error"));
    View v2(shell);
    QVERIFY(v2.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(unk)}}));
    QVERIFY(imageLooksRendered(v2.shot(QStringLiteral("unsupported-version.png"))));
    QQuickItem* sw = findByObjectName(v2.root(), QStringLiteral("versionSwitch"));
    QVERIFY(sw && reallyVisible(sw));
    JValue invalid = loadFixture(QStringLiteral("v0.2/todo-kanban/bundle.json"));
    JValue view = invalid.get(QStringLiteral("view"));
    JValue slots0 = view.get(QStringLiteral("slots"));
    slots0.set(QStringLiteral("main"), JValue::object({{QStringLiteral("type"), QStringLiteral("WebView")}, {QStringLiteral("props"), JValue::object({{QStringLiteral("url"), QStringLiteral("https://example.com")}})}}));
    view.set(QStringLiteral("slots"), slots0);
    invalid.set(QStringLiteral("view"), view);
    auto* inv = new AppViewModel(QStringLiteral("invalid-app"), nullptr, this);
    inv->setDetail(JValue::object({{QStringLiteral("appId"), QStringLiteral("invalid-app")}, {QStringLiteral("appEpoch"), 1}, {QStringLiteral("activeRevisionId"), QStringLiteral("x")}, {QStringLiteral("bundle"), invalid}}));
    QCOMPARE(inv->mode(), QStringLiteral("error"));
    QVERIFY(inv->errorText().contains(QStringLiteral("WebView")));
  }

  void injectionShownAsPlainText() {
    auto* vm = scenarioView(QStringLiteral("scenario-v2-fault-text.json"), this);
    const QString evil = QStringLiteral("<script>alert(1)</script><b>粗</b> import QtQuick; Item { Component.onCompleted: Qt.quit() } file:///etc/passwd https://x.example <img src=x onerror=alert(1)>");
    vm->applySource(QStringLiteral("m"), JValue::object({{QStringLiteral("detail"), evil}}));
    auto* cov = scenarioView(QStringLiteral("scenario-v3-coverage.json"), this);
    for (AppViewModel* m : {vm, cov}) {
      View v(shell);
      QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(m)}}));
      QTest::qWait(50);
      bool found = false;
      for (QQuickItem* t : itemsOfClass(v.root(), "QQuickText")) {
        QCOMPARE(t->property("textFormat").toInt(), 0);  // Text.PlainText on every text item
        if (t->property("text").toString() == evil) found = true;
      }
      for (QQuickItem* t : itemsOfClass(v.root(), "QQuickTextEdit")) QCOMPARE(t->property("textFormat").toInt(), 0);
      if (m == vm) QVERIFY2(found, "the injected string must appear verbatim as plain text");
      QCOMPARE(v.guard->blocked, 0);
      QVERIFY(v.view.isVisible());  // nothing quit the app
    }
  }

  void engineRefusesForeignUrls() {
    View v(shell);
    QVERIFY(v.load(QStringLiteral("Blocked.qml")));
    for (const char* u : {"file:///tmp/evil.qml", "http://example.com/x.qml", "https://example.com/x.js", "data:text/plain,Item{}", "qrc:/other/evil.qml", "file:///nix/store/../tmp/x.qml"})
      QVERIFY2(!v.guard->allowed(QUrl(QString::fromLatin1(u))), u);
    QVERIFY(v.guard->allowed(QUrl(QStringLiteral("qrc:/agentos/qml/Main.qml"))));
    // Actually try to load a file-system component: it is substituted by Blocked.qml (an empty Item).
    QFile evil(dir.path() + QStringLiteral("/evil.qml"));
    QVERIFY(evil.open(QIODevice::WriteOnly));
    evil.write("import QtQuick\nRectangle { objectName: \"evil\"; width: 10; height: 10 }\n");
    evil.close();
    const int before = v.guard->blocked;
    QQmlComponent c(v.view.engine(), QUrl::fromLocalFile(evil.fileName()));
    QObject* o = c.create();
    QVERIFY(v.guard->blocked > before);
    QVERIFY(!o || o->objectName() != QLatin1String("evil"));
    delete o;
  }

  void everyControlHasAnAccessibleName() {
    auto* cov = scenarioView(QStringLiteral("scenario-v3-coverage.json"), this);
    View v(shell, {1100, 2000});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(cov)}}));
    int controls = 0;
    for (int tab = 0; tab < 3; ++tab) {
      cov->setTab(QStringLiteral("/view/slots/main"), tab);
      QTest::qWait(80);
      for (QQuickItem* c : itemsOfClass(v.root(), "QQuickItem")) {
        if (!(c->inherits("QQuickControl") || c->inherits("QQuickTextField") || c->inherits("QQuickTextArea"))) continue;
        if (!reallyVisible(c) || c->inherits("QQuickTabBar") || c->inherits("QQuickScrollBar") || c->inherits("QQuickPopupItem")) continue;
        controls++;
        QVERIFY2(!accessibleName(c).isEmpty(), c->metaObject()->className());
      }
    }
    QVERIFY(controls >= 15);
  }

  void listInstanceBudgetAndLazyCreation() {
    // 10 Lists x 100 items x 24-node templates = 24000 potential instances. Valid (not rejected); at most 4096 live.
    JValue val = loadFixture(QStringLiteral("v1.0/slot-vectors/validation.json"));
    JValue view;
    for (const auto& c : val.get(QStringLiteral("cases")).items())
      if (c.get(QStringLiteral("name")).str() == QLatin1String("list:many-instances-valid")) view = c.get(QStringLiteral("view"));
    QVERIFY(view.isObject());
    JValue bundle = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-coverage.json")).get(QStringLiteral("bundle"));
    bundle.set(QStringLiteral("view"), view);
    auto* vm = new AppViewModel(QStringLiteral("big"), nullptr, this);
    vm->setDetail(JValue::object({{QStringLiteral("appId"), QStringLiteral("big")}, {QStringLiteral("appEpoch"), 1}, {QStringLiteral("activeRevisionId"), QStringLiteral("r")}, {QStringLiteral("bundle"), bundle}}));
    QCOMPARE(vm->mode(), QStringLiteral("slot"));  // the local budget never invalidates a valid tree
    JValue items = JValue::array();
    for (int i = 0; i < 150; ++i) items.push(JValue::object({{QStringLiteral("id"), QStringLiteral("i%1").arg(i)}}));
    vm->applySource(QStringLiteral("main"), JValue::object({{QStringLiteral("a"), items}}));
    InstanceBudget* b = InstanceBudget::instance();
    b->resetStats();
    View v(shell, {1200, 6000});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(vm)}}));
    QTest::qWait(200);
    QVERIFY(b->live() > 0);
    QList<QQuickItem*> lists;
    for (QQuickItem* i : itemsOfClass(v.root(), "QQuickListView"))
      if (i->objectName() == QLatin1String("slotList")) lists << i;
    QCOMPARE(lists.size(), 10);
    int created = 0;
    for (QQuickItem* lv : lists) {
      QCOMPARE(lv->property("count").toInt(), 100);  // List shows at most 100 items (protocol), all reachable
      created += lv->property("contentItem").value<QQuickItem*>()->childItems().size();
    }
    QVERIFY2(created < 1000, qPrintable(QString::number(created)));  // lazily instantiated, not 1000 x 24
    // scroll every list to its end: the last item is instantiated and gets budget
    // Scroll each list like a user (page by page) to its end: every one of the 100 items gets instantiated and
    // rendered at some point, while the live instance count stays within the budget.
    for (QQuickItem* lv : {lists.first(), lists.last()}) {
      QSet<int> seen;
      for (int step = 0; step < 600 && seen.size() < 100; ++step) {
        for (QQuickItem* it : lv->property("contentItem").value<QQuickItem*>()->childItems())
          if (it->property("granted").toBool() && it->property("index").isValid()) seen.insert(it->property("index").toInt());
        if (lv->property("atYEnd").toBool() && step > 0 && seen.contains(99)) break;
        lv->setProperty("contentY", lv->property("contentY").toDouble() + 450);
        QTest::qWait(1);
        QVERIFY(b->live() <= 4096);
      }
      QVERIFY2(seen.size() == 100, qPrintable(QString::number(seen.size())));
      QMetaObject::invokeMethod(lv, "positionViewAtBeginning");
    }
    QVERIFY(b->peak() <= 4096);
    // A tight budget: overflow items wait (placeholder) instead of failing; freeing budget lets them render.
    b->setLimitForTest(b->live() + 30);
    for (QQuickItem* lv : lists) QMetaObject::invokeMethod(lv, "positionViewAtBeginning");
    QTest::qWait(150);
    QVERIFY(b->live() <= b->limit());
    b->setLimitForTest(4096);
    emit b->freed();
    QTest::qWait(100);
    QVERIFY(b->live() <= 4096);
    QVERIFY(imageLooksRendered(v.shot(QStringLiteral("list-budget.png"))));
  }

  void chartLimitsAndOddData() {
    JValue sc = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-coverage.json"));
    auto* vm = scenarioView(QStringLiteral("scenario-v3-coverage.json"), this);
    JValue rows = JValue::array();
    for (int i = 0; i < 800; ++i)
      rows.push(JValue::object({{QStringLiteral("x"), i}, {QStringLiteral("a"), i % 7 == 0 ? JValue(QStringLiteral("NaN")) : JValue(double(i))}, {QStringLiteral("b"), i % 5 == 0 ? JValue::null() : JValue(QString(5000, QLatin1Char('z')))}}));
    vm->applySource(QStringLiteral("chart"), JValue::object({{QStringLiteral("rows"), rows}}));
    JValue snap = vm->runtime().render();
    JValue chart;
    std::function<void(const JValue&)> find = [&](const JValue& e) {
      if (e.get(QStringLiteral("type")).str() == QLatin1String("BarChart")) chart = e;
      for (const auto& c : e.get(QStringLiteral("children")).items()) find(c);
    };
    for (const auto& e : snap.items()) find(e);
    QVERIFY(chart.isObject());
    QCOMPARE(chart.get(QStringLiteral("xs")).size(), 500);
    QCOMPARE(chart.get(QStringLiteral("truncatedRows")).toNumber(), 300.0);
    for (const auto& s : chart.get(QStringLiteral("series")).items()) QCOMPARE(s.get(QStringLiteral("values")).size(), 500);
    QCOMPARE(chart.get(QStringLiteral("series")).at(1).get(QStringLiteral("values")).at(1).toNumber(), 0.0);  // non-numbers draw as 0
    View v(shell, {1100, 1400});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(vm)}}));
    QList<QQuickItem*> charts = itemsOfClass(v.root(), "agentos::ChartItem");
    QVERIFY(charts.size() >= 2);
    for (QQuickItem* c : charts) {
      QVERIFY(c->property("pointCount").toInt() <= 8 * 500);
      QVERIFY(!accessibleName(c).isEmpty());
    }
    QVERIFY(imageLooksRendered(v.shot(QStringLiteral("charts-limits.png"))));
    // a ChartItem fed more than allowed clamps itself too
    ChartItem ci;
    QVariantList many;
    for (int s = 0; s < 12; ++s) many << QVariantMap{{QStringLiteral("label"), s}, {QStringLiteral("values"), QVariantList(900, 1.0)}};
    ci.setSeries(many);
    QStringList xs;
    for (int i = 0; i < 900; ++i) xs << QString::number(i);
    ci.setXs(xs);
    QCOMPARE(ci.series().size(), 8);
    QCOMPARE(ci.xs().size(), 500);
    QCOMPARE(ci.pointCount(), 8 * 500);
  }

  void keyboardFocusAndScaling() {
    auto* cov = scenarioView(QStringLiteral("scenario-v3-coverage.json"), this);
    cov->setTab(QStringLiteral("/view/slots/main"), 1);
    View v(shell, {1100, 2000});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(cov)}}));
    v.view.requestActivate();
    QTest::qWait(50);
    QSet<QQuickItem*> reached;
    QList<QQuickItem*> order;
    for (int i = 0; i < 60; ++i) {
      QTest::keyClick(&v.view, Qt::Key_Tab);
      QQuickItem* f = v.view.activeFocusItem();
      if (!f) continue;
      QQuickItem* ctl = f;
      while (ctl && !(ctl->inherits("QQuickControl") || ctl->inherits("QQuickTextField") || ctl->inherits("QQuickTextArea"))) ctl = ctl->parentItem();
      if (!ctl) continue;
      if (!reached.contains(ctl)) order << ctl;
      reached.insert(ctl);
      // visible focus: the control's FocusRing is in its focused state
      QObject* bg = ctl->property("background").value<QObject*>();
      if (bg && bg->property("on").isValid()) QVERIFY2(bg->property("on").toBool(), ctl->metaObject()->className());
    }
    QVERIFY2(reached.size() >= 10, qPrintable(QString::number(reached.size())));
    // Tab order follows the visual order (top to bottom) for the first controls
    for (int i = 1; i < std::min<int>(4, order.size()); ++i) QVERIFY(order[i]->mapToScene({0, 0}).y() >= order[i - 1]->mapToScene({0, 0}).y() - 1);
    // Ctrl+= scales text
    QQuickItem* anyText = itemsOfClass(v.root(), "QQuickText").value(0);
    const int before = anyText->property("font").value<QFont>().pixelSize();
    shell->zoom(2);
    QTest::qWait(30);
    QVERIFY(anyText->property("font").value<QFont>().pixelSize() > before);
    shell->zoom(0);
  }

  void preeditCommitOnFieldSwitchDiscardOnScopeClear() {
    auto* cov = scenarioView(QStringLiteral("scenario-v3-coverage.json"), this);
    cov->setTab(QStringLiteral("/view/slots/main"), 1);
    View v(shell, {1100, 2000});
    QVERIFY(v.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(cov)}}));
    QList<QQuickItem*> fields;
    for (QQuickItem* f : itemsOfClass(v.root(), "QQuickTextField"))
      if (reallyVisible(f)) fields << f;
    QVERIFY(fields.size() >= 2);
    QQuickItem* a = fields[0];
    QQuickItem* b = fields[1];
    a->forceActiveFocus();
    QTest::qWait(10);
    ImeGuard::compose(a, QString::fromUtf8("中文"));
    QCOMPARE(ImeGuard::preedit(a), QString::fromUtf8("中文"));
    b->forceActiveFocus();  // switch field while composing
    QTest::qWait(20);
    QVERIFY(ImeGuard::preedit(a).isEmpty());
    QCOMPARE(a->property("text").toString(), QString::fromUtf8("中文"));  // committed into its own field
    QVERIFY(b->property("text").toString().isEmpty());                    // never into the next field
    ImeGuard::compose(b, QString::fromUtf8("拼音"));
    QCOMPARE(ImeGuard::preedit(b), QString::fromUtf8("拼音"));
    emit shell->scopeCleared(QStringLiteral("workspace"));  // workspace switch / lock
    QTest::qWait(20);
    QVERIFY(ImeGuard::preedit(b).isEmpty());
    QVERIFY(b->property("text").toString().isEmpty());
    QVERIFY(a->property("text").toString().isEmpty());
    // Chinese text renders (simplified + traditional) through plain text items
    cov->typeText(QStringLiteral("f"), QStringLiteral("title"), QString::fromUtf8("简体繁體"));
    QTest::qWait(20);
    QCOMPARE(fields[0]->property("text").toString(), QString::fromUtf8("简体繁體"));
  }

  void trustedConfirmCannotBeCovered() {
    View v(shell, {1280, 900});
    QVERIFY(v.load(QStringLiteral("ShellRoot.qml")));
    // an app view that tries to look like a system approval lives inside a clipped card
    bool answered = false, result = true;
    shell->askAppConfirm(QStringLiteral("伪造应用"), QString::fromUtf8("系统已批准，请点确认"), [&](bool yes) {
      answered = true;
      result = yes;
    });
    QTest::qWait(50);
    QQuickItem* layer = findByObjectName(v.root(), QStringLiteral("trustedConfirm"));
    QQuickItem* ok = findByObjectName(v.root(), QStringLiteral("confirmAccept"));
    QVERIFY(layer && ok && reallyVisible(ok));
    // hit test at the confirm button: the topmost item there belongs to the trusted layer
    const QPointF center = ok->mapToScene(QPointF(ok->width() / 2, ok->height() / 2));
    QQuickItem* top = v.root();
    for (;;) {
      QQuickItem* c = top->childAt(top->mapFromScene(center).x(), top->mapFromScene(center).y());
      if (!c) break;
      top = c;
    }
    bool inLayer = false;
    for (QQuickItem* i = top; i; i = i->parentItem()) inLayer = inLayer || i == layer;
    QVERIFY(inLayer);
    QVERIFY(layer->z() >= 1000);
    QQuickItem* page = findByObjectName(v.root(), QStringLiteral("page"));
    QVERIFY(page && page->clip() && page->z() < layer->z());
    // app text is shown labelled as app-provided; the confirmation is bound to the epochs it was shown under
    QVERIFY(shell->confirm().value(QStringLiteral("appText")).toString().contains(QString::fromUtf8("系统已批准")));
    shell->applyStatusForTest(JValue::object({{QStringLiteral("sessionEpoch"), 99}, {QStringLiteral("locked"), true}}));  // lock -> confirmation withdrawn
    QVERIFY(answered);
    QVERIFY(!result);
    QVERIFY(!shell->confirm().value(QStringLiteral("visible")).toBool());
    v.shot(QStringLiteral("trusted-confirm.png"));
  }

  void lockClearsSensitiveState() {
    QGuiApplication::clipboard()->setText(QStringLiteral("secret clipboard"));
    shell->setIntentDraft(QStringLiteral("把我的密码记下来"));
    shell->onLocked();
    QVERIFY(QGuiApplication::clipboard()->text().isEmpty());
    QVERIFY(shell->intentDraft().isEmpty());
    QVERIFY(shell->locked());
  }
};

QTEST_MAIN(GuiTest)
#include "gui_test.moc"
