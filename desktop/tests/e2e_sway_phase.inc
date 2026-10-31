// Body of E2E::sway() (included inside the class; see e2e_sway.hpp for the handshake). Each block ends with one
// "E2E <step> <json>" line the VM script checks against the Host's database. A failed QVERIFY ends the phase.
void sway() {
  if (phase != QLatin1String("sway")) QSKIP("phase");
  Asker A(envOr("AGENTOS_E2E_ASK_DIR", QStringLiteral("/tmp/agentos-e2e-sway")));
  QScreen* scr = QGuiApplication::primaryScreen();
  QVERIFY(scr);
  const QSize screen = scr->size();
  Real r(screen, envOr("AGENTOS_E2E_LAYOUT_DIR", QString()));
  QVERIFY2(r.up(), "Shell did not bind a session on the real gateway");
  r.view->view.showFullScreen();
  QTRY_VERIFY_WITH_TIMEOUT(r.view->view.width() == screen.width() && r.view->view.height() == screen.height(), 20000);
  QTest::qWait(1500);
  report(QStringLiteral("bound"), {{QStringLiteral("workspaceId"), r.shell->workspaceId()}, {QStringLiteral("user"), r.shell->userName()},
                                   {QStringLiteral("w"), screen.width()}, {QStringLiteral("h"), screen.height()}, {QStringLiteral("platform"), QGuiApplication::platformName()}});
  QCOMPARE(QGuiApplication::platformName(), QStringLiteral("wayland"));
  QQuickWindow* win = &r.view->view;

  // ---- real input helpers ----
  auto inWindow = [&](QQuickItem* i, QQuickWindow* w) {
    const QPointF c = centerOf(i);
    return c.x() >= 1 && c.y() >= 1 && c.x() < w->width() - 1 && c.y() < w->height() - 1;
  };
  QQuickWindow* cur = win;  // the window the next click lands in (fixture windows replace the Shell for a while)
  auto click = [&](QQuickItem* i, bool dbl = false) -> int {
    if (!i) return -1;
    if (!inWindow(i, cur)) {
      std::printf("E2E-DIAG click target %s '%s' at %.0f,%.0f is outside the %dx%d window\n", i->metaObject()->className(), qPrintable(i->property("label").toString()),
                  centerOf(i).x(), centerOf(i).y(), cur->width(), cur->height());
      return -1;
    }
    ClickCounter cc;
    const bool sig = i->metaObject()->indexOfSignal("clicked()") >= 0;
    if (sig) QObject::connect(i, SIGNAL(clicked()), &cc, SLOT(hit()));
    const QPointF c = centerOf(i);
    A.ask(dbl ? QStringLiteral("dblclick") : QStringLiteral("click"), {{QStringLiteral("x"), qRound(c.x())}, {QStringLiteral("y"), qRound(c.y())}});
    QTest::qWait(500);
    if (sig) QObject::disconnect(i, SIGNAL(clicked()), &cc, SLOT(hit()));
    return sig ? cc.n : 1;
  };
  auto keys = [&](const QStringList& k) {
    A.ask(QStringLiteral("keys"), {{QStringLiteral("keys"), k}});
    QTest::qWait(300);
  };
  auto typeInto = [&](QQuickItem* f, const QString& text) -> bool {
    if (!f) return false;
    for (int attempt = 0; attempt < 3; ++attempt) {
      click(f);
      QTest::qWaitFor([&] { return f->hasActiveFocus(); }, 5000);
      if (!f->property("text").toString().isEmpty()) keys({QStringLiteral("ctrl-a"), QStringLiteral("backspace")});
      A.ask(QStringLiteral("type"), {{QStringLiteral("text"), text}});
      if (QTest::qWaitFor([&] { return f->property("text").toString() == text; }, 5000)) return true;
      std::printf("E2E-DIAG typed '%s' into '%s', the field holds '%s' (focus %d)\n", qPrintable(text), qPrintable(f->property("label").toString()),
                  qPrintable(f->property("text").toString()), int(f->hasActiveFocus()));
    }
    return false;
  };
  // the root to search: the window's content item (combo box popups live in its overlay, not under the root object)
  auto byLabelIn = [&](QQuickWindow* w, const QString& label, bool enabledOnly = true) -> QQuickItem* {
    QQuickItem* hit = nullptr;
    walkItems(w->contentItem(), [&](QQuickItem* i) {
      if (!hit && reallyVisible(i) && i->property("label").toString() == label && (!enabledOnly || i->isEnabled())) hit = i;
    });
    return hit;
  };
  auto byLabel = [&](const QString& label) { return byLabelIn(cur, label); };
  auto byName = [&](const QString& name) -> QQuickItem* {
    QQuickItem* hit = nullptr;
    walkItems(cur->contentItem(), [&](QQuickItem* i) {
      if (!hit && i->objectName() == name && reallyVisible(i)) hit = i;
    });
    return hit;
  };
  auto textShown = [&](const QString& needle, bool exact = false) {
    bool hit = false;
    walkItems(cur->contentItem(), [&](QQuickItem* i) {
      if (!reallyVisible(i)) return;
      const QString t = i->property("text").toString();
      if (exact ? t == needle : t.contains(needle)) hit = true;
    });
    return hit;
  };
  // choose an option of a combo box by real clicks: open it, then click the delegate with that label in its popup
  auto choose = [&](QQuickItem* comboRaw, const QString& optionLabel) -> bool {
    // a Repeater may recreate the combo box while we work (filters follow every record change): keep a guarded pointer
    QPointer<QQuickItem> combo(comboRaw);
    if (!combo) return false;
    for (int attempt = 0; attempt < 2 && combo; ++attempt) {
      click(combo);
      QQuickItem* opt = nullptr;
      QTest::qWaitFor([&] {
        walkItems(cur->contentItem(), [&](QQuickItem* i) {
          if (!opt && i->inherits("QQuickItemDelegate") && reallyVisible(i) && accessibleName(i) == optionLabel) opt = i;
        });
        return opt != nullptr;
      }, 5000);
      if (!opt) {
        std::printf("E2E-DIAG combo '%s': no visible option '%s'\n", qPrintable(combo->property("label").toString()), qPrintable(optionLabel));
        keys({QStringLiteral("esc")});
        continue;
      }
      click(opt);
      if (QTest::qWaitFor([&] { return !combo || combo->property("displayText").toString() == optionLabel; }, 5000)) return true;
    }
    return false;
  };
  // what Sway scanned out equals the window's own frame at a grid of points (cursor and blinking caret tolerated)
  auto onOutput = [&](const QString& name, QQuickWindow* w) -> double {
    QTest::qWait(600);
    const QImage me = w->grabWindow();
    QVariantList pts;
    for (int gy = 0; gy < 9; ++gy)
      for (int gx = 0; gx < 12; ++gx) pts << QVariant(QVariantList{int((gx + 0.5) * me.width() / 12), int((gy + 0.5) * me.height() / 9)});
    const JValue got = A.ask(QStringLiteral("shot"), {{QStringLiteral("name"), name}, {QStringLiteral("points"), pts}});
    if (int(got.get(QStringLiteral("w")).toNumber()) != me.width() || int(got.get(QStringLiteral("h")).toNumber()) != me.height()) {
      std::printf("E2E-DIAG shot %s: output %gx%g, window frame %dx%d\n", qPrintable(name), got.get(QStringLiteral("w")).toNumber(), got.get(QStringLiteral("h")).toNumber(), me.width(), me.height());
      return 0;
    }
    int same = 0;
    const JValue& px = got.get(QStringLiteral("px"));
    for (int k = 0; k < pts.size(); ++k) {
      const QVariantList p = pts[k].toList();
      const QColor c = me.pixelColor(p[0].toInt(), p[1].toInt());
      const JValue& o = px.at(k);
      if (std::abs(c.red() - int(o.at(0).toNumber())) <= 12 && std::abs(c.green() - int(o.at(1).toNumber())) <= 12 && std::abs(c.blue() - int(o.at(2).toNumber())) <= 12) ++same;
    }
    const double ratio = double(same) / pts.size();
    std::printf("E2E-SHOT %s %d/%lld points equal\n", qPrintable(name), same, static_cast<long long>(pts.size()));
    return ratio;
  };
  auto doDriver = [&](const QString& what, QVariantMap args = {}, int ms = 240000) {
    args.insert(QStringLiteral("what"), what);
    return A.ask(QStringLiteral("do"), args, ms);
  };
  // requests in alice's own login session (a child of this process, so the gateway binds the same logind session)
  auto rpcHere = [&](const QString& file) -> QStringList {
    QProcess p;
    p.start(QStringLiteral("python3"), {QStringLiteral("/etc/agentos-test/rpc.py"), QStringLiteral("/run/agentos/gateway.sock"), QLatin1Char('@') + file});
    p.waitForFinished(300000);
    const QStringList out = QString::fromUtf8(p.readAllStandardOutput()).split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    std::printf("E2E-RPC %s rc=%d %s\n", qPrintable(file), p.exitCode(), qPrintable(out.join(QLatin1Char(' ')).left(600)));
    return out;
  };
  auto page = [&](const QString& id) -> bool {
    QQuickItem* b = byName(QStringLiteral("nav:") + id);
    if (click(b) < 1) return false;
    return QTest::qWaitFor([&] { return r.shell->currentPage() == id; }, 10000);
  };

  QVERIFY2(onOutput(QStringLiteral("frame"), win) >= 0.9, "the Shell window is not what Sway scanned out");
  report(QStringLiteral("frame"), {});

  // ---- D02: a declarative app from an intent typed on the keyboard and submitted with the pointer ----
  QVERIFY(page(QStringLiteral("home")));
  const QSet<QString> runs0 = r.runIds();
  QVERIFY(page(QStringLiteral("home")));
  QVERIFY2(typeInto(byName(QStringLiteral("intentInput")), QStringLiteral("make a todo app")), "intent not typed");
  QCOMPARE(click(byName(QStringLiteral("intentSubmit"))), 1);
  QString run1;
  QTest::qWaitFor([&] {
    for (const QString& id : r.runIds())
      if (!runs0.contains(id)) run1 = id;
    return !run1.isEmpty();
  }, 60000);
  QVERIFY2(!run1.isEmpty(), "the real click on 提交 started no run");
  QCOMPARE(r.waitRun(run1, 240000), QStringLiteral("succeeded"));
  QVERIFY(page(QStringLiteral("home")));
  QTRY_VERIFY_WITH_TIMEOUT(r.appCount() >= 1, 30000);
  const QString todo = r.app(0).get(QStringLiteral("appId")).str();
  const QString todoTitle = r.app(0).get(QStringLiteral("title")).str();
  report(QStringLiteral("generated"), {{QStringLiteral("runId"), run1}, {QStringLiteral("appId"), todo}, {QStringLiteral("title"), todoTitle}});

  auto openTodo = [&]() -> AppViewModel* {
    if (r.shell->currentPage() != QLatin1String("home")) page(QStringLiteral("home"));
    QTest::qWait(500);
    click(byLabel(QStringLiteral("打开")));
    if (!QTest::qWaitFor([&] { return r.shell->currentPage() == QLatin1String("app"); }, 10000)) return nullptr;
    auto* v = qobject_cast<AppViewModel*>(r.shell->appView(todo));
    if (v) QTest::qWaitFor([&] { return v->mode() == QLatin1String("records") && rows(v) >= 0 && !v->recordState().value(QStringLiteral("loading")).toBool(); }, 20000);
    QTest::qWait(800);
    return v;
  };
  AppViewModel* v = openTodo();
  QVERIFY2(v && v->mode() == QLatin1String("records"), "the real click on 打开 did not open the to-do app");
  auto st = [&](const char* k) { return v->recordState().value(QString::fromLatin1(k)); };
  auto newRecord = [&](const QString& title, bool dbl = false) -> bool {
    if (click(byLabel(QStringLiteral("新建"))) < 1) return false;
    if (!QTest::qWaitFor([&] { return st("formOpen").toBool(); }, 5000)) return false;
    if (!typeInto(byLabel(QStringLiteral("任务")), title)) return false;
    const int n = total(v);
    click(byLabel(QStringLiteral("保存")), dbl);
    const bool ok = QTest::qWaitFor([&] { return total(v) >= n + 1 && !st("formOpen").toBool(); }, 20000);
    if (!ok) std::printf("E2E-DIAG new record %s: %s\n", qPrintable(title), qPrintable(writeDiag(r, v, n, {})));
    return ok;
  };
  // default rule: a new record's 已完成 starts unchecked (field default false)
  const int n0 = total(v);
  QCOMPARE(click(byLabel(QStringLiteral("新建"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(st("formOpen").toBool(), 5000);
  QQuickItem* doneBox = byLabel(QStringLiteral("已完成"));
  QVERIFY(doneBox && doneBox->inherits("QQuickCheckBox"));
  QCOMPARE(doneBox->property("checked").toBool(), false);
  QStringList formFields;
  for (const QVariant& f : v->recordForm()) formFields << f.toMap().value(QStringLiteral("name")).toString();
  QCOMPARE(click(byLabel(QStringLiteral("取消"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(!st("formOpen").toBool(), 5000);
  QVERIFY2(newRecord(QStringLiteral("milk-1")), "create through the form failed");
  QTRY_VERIFY_WITH_TIMEOUT(textShown(QStringLiteral("milk-1"), true), 10000);
  // V1-D04: a double click on 保存 is one business effect (the form's idempotency key; busy state)
  QVERIFY2(newRecord(QStringLiteral("dup-2"), true), "create with a double click failed");
  QTest::qWait(3000);
  const int afterDup = total(v);
  const JValue dupCount = doDriver(QStringLiteral("count"), {{QStringLiteral("appId"), todo}, {QStringLiteral("text"), QStringLiteral("dup-2")}});
  report(QStringLiteral("doubleClick"), {{QStringLiteral("total"), afterDup}, {QStringLiteral("before"), n0}, {QStringLiteral("dbCount"), dupCount.get(QStringLiteral("count")).toNumber()}});
  QCOMPARE(afterDup, n0 + 2);
  QCOMPARE(int(dupCount.get(QStringLiteral("count")).toNumber()), 1);
  // search typed into the 搜索 field
  QVERIFY(typeInto(byLabel(QStringLiteral("搜索")), QStringLiteral("dup-2")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
  QVERIFY(textShown(QStringLiteral("dup-2"), true) && !textShown(QStringLiteral("milk-1"), true));
  keys({QStringLiteral("ctrl-a"), QStringLiteral("backspace")});
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == std::min(total(v), 20), 20000);
  // edit milk-1: mark done with a real click on the checkbox
  QVERIFY(typeInto(byLabel(QStringLiteral("搜索")), QStringLiteral("milk-1")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
  QCOMPARE(click(byLabel(QStringLiteral("编辑"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(st("formOpen").toBool() && st("formMode").toString() == QLatin1String("edit"), 5000);
  doneBox = byLabel(QStringLiteral("已完成"));
  QVERIFY(doneBox);
  click(doneBox);
  QTRY_VERIFY_WITH_TIMEOUT(doneBox->property("checked").toBool(), 5000);
  QCOMPARE(click(byLabel(QStringLiteral("保存"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(!st("formOpen").toBool(), 20000);
  const JValue milkDone = doDriver(QStringLiteral("record"), {{QStringLiteral("appId"), todo}, {QStringLiteral("text"), QStringLiteral("milk-1")}});
  // delete dup-2 through the confirmation row
  QVERIFY(typeInto(byLabel(QStringLiteral("搜索")), QStringLiteral("dup-2")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
  QCOMPARE(click(byLabel(QStringLiteral("删除"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(st("hasDelete").toBool(), 5000);
  QCOMPARE(click(byLabel(QStringLiteral("确认删除"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 0, 20000);
  keys({QStringLiteral("ctrl-a"), QStringLiteral("backspace")});
  QTRY_COMPARE_WITH_TIMEOUT(total(v), n0 + 1, 20000);
  const JValue dupAfter = doDriver(QStringLiteral("count"), {{QStringLiteral("appId"), todo}, {QStringLiteral("text"), QStringLiteral("dup-2")}});
  QCOMPARE(int(dupAfter.get(QStringLiteral("count")).toNumber()), 0);
  report(QStringLiteral("crud"), {{QStringLiteral("formFields"), formFields}, {QStringLiteral("milk"), milkDone.toVariant()}, {QStringLiteral("total"), total(v)}});
  QVERIFY2(onOutput(QStringLiteral("records"), win) >= 0.9, "records view not on the output");

  // ---- D02: modify the app (priority + filter), hidden field after switching back, data kept ----
  const double epoch1 = r.appById(todo).get(QStringLiteral("appEpoch")).toVariant().toDouble();
  QVERIFY(page(QStringLiteral("home")));
  QVERIFY(typeInto(byName(QStringLiteral("intentInput")), QStringLiteral("add priority")));
  QVERIFY2(choose(byLabel(QStringLiteral("目标应用")), todoTitle), "target app not chosen");
  const QSet<QString> runs1 = r.runIds();
  QVERIFY(page(QStringLiteral("home")));
  QCOMPARE(byLabel(QStringLiteral("目标应用")) ? byLabel(QStringLiteral("目标应用"))->property("displayText").toString() : QString(), todoTitle);
  QCOMPARE(click(byName(QStringLiteral("intentSubmit"))), 1);
  QString run2;
  QTest::qWaitFor([&] {
    for (const QString& id : r.runIds())
      if (!runs1.contains(id)) run2 = id;
    return !run2.isEmpty();
  }, 60000);
  QVERIFY(!run2.isEmpty());
  QCOMPARE(r.waitRun(run2, 240000), QStringLiteral("succeeded"));
  QVERIFY(page(QStringLiteral("home")));
  QTRY_VERIFY_WITH_TIMEOUT(r.appById(todo).get(QStringLiteral("appEpoch")).toVariant().toDouble() > epoch1, 30000);
  v = openTodo();
  QVERIFY(v);
  QTRY_VERIFY_WITH_TIMEOUT(v->records()->property("headers").toStringList().contains(QStringLiteral("优先级")), 20000);
  QVERIFY2(newRecord(QStringLiteral("prio-3")), "prio-3 not created");
  // set prio-3's priority to high through the edit form's combo box
  QVERIFY(typeInto(byLabel(QStringLiteral("搜索")), QStringLiteral("prio-3")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
  QCOMPARE(click(byLabel(QStringLiteral("编辑"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(st("formOpen").toBool(), 5000);
  QVERIFY2(choose(byLabel(QStringLiteral("优先级")), QStringLiteral("high")), "priority not chosen");
  QCOMPARE(click(byLabel(QStringLiteral("保存"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(!st("formOpen").toBool(), 20000);
  keys({QStringLiteral("ctrl-a"), QStringLiteral("backspace")});
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 3, 20000);
  // filter by priority = high (real combo box) shows prio-3 only
  QVERIFY2(choose(byLabel(QStringLiteral("筛选优先级")), QStringLiteral("high")), "filter not chosen");
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1 && textShown(QStringLiteral("prio-3"), true), 20000);
  QVERIFY(choose(byLabel(QStringLiteral("筛选优先级")), QStringLiteral("优先级：全部")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 3, 20000);
  const int totalV2 = total(v);
  // back to the first version from the app detail page: priority becomes a hidden field, records stay
  r.go(QStringLiteral("app"));
  QTRY_VERIFY_WITH_TIMEOUT(r.model(r.shell->revisions())->count() >= 2, 20000);
  QCOMPARE(click(byLabel(QStringLiteral("切换到此版本"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(r.actionState(QStringLiteral("app.deploy")) == QLatin1String("reconciled") || r.actionState(QStringLiteral("app.deploy")) == QLatin1String("failed"), 120000);
  QCOMPARE(r.actionState(QStringLiteral("app.deploy")), QStringLiteral("reconciled"));
  v = openTodo();
  QVERIFY(v);
  QTRY_VERIFY_WITH_TIMEOUT(!v->records()->property("headers").toStringList().contains(QStringLiteral("优先级")) && total(v) == totalV2, 20000);
  const QStringList headersV1 = v->records()->property("headers").toStringList();
  const JValue prio = doDriver(QStringLiteral("record"), {{QStringLiteral("appId"), todo}, {QStringLiteral("text"), QStringLiteral("prio-3")}});
  // and forward again to the newest version
  r.go(QStringLiteral("app"));
  QTRY_VERIFY_WITH_TIMEOUT(byLabel(QStringLiteral("切换到此版本")) != nullptr, 20000);
  QCOMPARE(click(byLabel(QStringLiteral("切换到此版本"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(r.action(QStringLiteral("app.deploy")).get(QStringLiteral("state")).str() == QLatin1String("reconciled"), 120000);
  v = openTodo();
  QVERIFY(v);
  QTRY_VERIFY_WITH_TIMEOUT(v->records()->property("headers").toStringList().contains(QStringLiteral("优先级")), 20000);
  report(QStringLiteral("version"), {{QStringLiteral("runId"), run2}, {QStringLiteral("headersV1"), headersV1}, {QStringLiteral("total"), totalV2}, {QStringLiteral("prio"), prio.toVariant()}});

  // ---- D05: markup, script, URLs typed into a record stay plain text; nothing is loaded ----
  const QString evil = QStringLiteral("<b>bold</b><img src=http://x.example/a.png> Qt.quit() file:///etc/passwd javascript:alert(1) {{x}} ${y}");
  const int blocked0 = r.view->guard->blocked;
  QVERIFY2(newRecord(evil), "the injection record was not saved");
  QVERIFY(typeInto(byLabel(QStringLiteral("搜索")), QStringLiteral("bold")));
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 1, 20000);
  QTRY_VERIFY_WITH_TIMEOUT(textShown(evil, true), 10000);
  int richText = 0;
  for (QQuickItem* t : itemsOfClass(win->contentItem(), "QQuickText"))
    if (reallyVisible(t) && t->property("textFormat").toInt() != 0) ++richText;
  const JValue evilRow = doDriver(QStringLiteral("record"), {{QStringLiteral("appId"), todo}, {QStringLiteral("text"), QStringLiteral("x.example")}});
  QVERIFY2(onOutput(QStringLiteral("injection"), win) >= 0.9, "injection view not on the output");
  report(QStringLiteral("injection"), {{QStringLiteral("richText"), richText}, {QStringLiteral("blocked"), r.view->guard->blocked - blocked0}, {QStringLiteral("db"), evilRow.toVariant()}});
  QCOMPARE(richText, 0);
  QCOMPARE(r.view->guard->blocked - blocked0, 0);
  QVERIFY(win->isVisible());
  keys({QStringLiteral("ctrl-a"), QStringLiteral("backspace")});

  // ---- D06: paging with the real 下一页 button (records added as setup data) ----
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) >= 3, 20000);
  for (int i = 0; total(v) < 26 && i < 40; ++i) {  // setup data, not a user step: straight through the view model
    const int n = total(v);
    v->openCreate();
    v->setDraft(QStringLiteral("title"), QStringLiteral("bulk-%1").arg(i));
    v->submitRecord();
    QTest::qWaitFor([&] { return total(v) > n; }, 10000);
  }
  QVERIFY(total(v) >= 26);
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 20, 20000);
  const QString page1 = st("pageText").toString();
  QCOMPARE(click(byLabel(QStringLiteral("下一页"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(st("pageText").toString() != page1 && rows(v) == total(v) - 20, 20000);
  QVERIFY(byLabel(QStringLiteral("上一页")) != nullptr);
  QCOMPARE(click(byLabel(QStringLiteral("上一页"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(rows(v) == 20, 20000);
  report(QStringLiteral("paging"), {{QStringLiteral("total"), total(v)}, {QStringLiteral("page1"), page1}});

  // ---- D03/D05/D06: the slot fixtures in a real window (all components, bindings, visibleWhen, limits) ----
  {
    auto scenario = [&](const QString& file) {
      JValue sc = loadFixture(QStringLiteral("v1.0/slot-vectors/") + file);
      auto* vm = new AppViewModel(sc.get(QStringLiteral("app")).get(QStringLiteral("appId")).str(), nullptr, this);
      vm->setDetail(JValue::object({{QStringLiteral("appId"), sc.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("appEpoch"), sc.get(QStringLiteral("app")).get(QStringLiteral("appEpoch"))},
                                    {QStringLiteral("activeRevisionId"), sc.get(QStringLiteral("app")).get(QStringLiteral("revisionId"))}, {QStringLiteral("bundle"), sc.get(QStringLiteral("bundle"))}}));
      for (const auto& s : sc.get(QStringLiteral("steps")).items())
        if (s.get(QStringLiteral("op")).str() == QLatin1String("load") && s.get(QStringLiteral("expect")).get(QStringLiteral("result")).toBool())
          vm->applySource(s.get(QStringLiteral("source")).str(), decodeMissing(s.get(QStringLiteral("output"))));
      return vm;
    };
    win->hide();
    QTest::qWait(500);
    auto* cov = scenario(QStringLiteral("scenario-v3-coverage.json"));
    JValue rowsJ = JValue::array();
    for (int i = 0; i < 800; ++i)
      rowsJ.push(JValue::object({{QStringLiteral("x"), i}, {QStringLiteral("a"), i % 7 == 0 ? JValue(QStringLiteral("NaN")) : JValue(double(i))}, {QStringLiteral("b"), i % 5 == 0 ? JValue::null() : JValue(QString(500, QLatin1Char('z')))}}));
    cov->applySource(QStringLiteral("chart"), JValue::object({{QStringLiteral("rows"), rowsJ}}));
    View fx(r.shell.get(), screen);
    QVERIFY(fx.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(cov)}}));
    fx.view.showFullScreen();
    QTRY_VERIFY_WITH_TIMEOUT(fx.view.width() == screen.width(), 20000);
    QTest::qWait(1500);
    cur = &fx.view;
    QVERIFY2(onOutput(QStringLiteral("coverage-tab0"), cur) >= 0.9, "coverage fixture not on the output");
    QStringList shown0;
    for (const QString& t : {QStringLiteral("固定说明"), QStringLiteral("数字"), QStringLiteral("常量"), QStringLiteral("表单回显"), QStringLiteral("全部完成")})
      if (textShown(t)) shown0 << t;
    int charts = 0, points = 0;
    for (QQuickItem* c : itemsOfClass(cur->contentItem(), "agentos::ChartItem")) {
      ++charts;
      points = std::max(points, c->property("pointCount").toInt());
    }
    // tabs by real clicks: 表格 shows the Form (标题 field), 列表 the List; visibleWhen on the list's 过期 marker
    QList<QQuickItem*> tabs;
    walkItems(cur->contentItem(), [&](QQuickItem* i) { if (i->inherits("QQuickTabButton") && reallyVisible(i)) tabs << i; });
    QVERIFY2(tabs.size() >= 3, qPrintable(QString::number(tabs.size())));
    click(tabs[1]);
    QQuickItem* titleField = nullptr;
    QTest::qWaitFor([&] { titleField = byLabel(QStringLiteral("标题")); return titleField && titleField->inherits("QQuickTextField"); }, 5000);
    QVERIFY2(titleField, "the 表格 tab's form did not appear after the real click");
    QVERIFY(typeInto(titleField, QStringLiteral("abc")));
    QQuickItem* urgent = byLabel(QStringLiteral("紧急"));
    if (urgent) click(urgent);
    const bool urgentOn = urgent && urgent->property("checked").toBool();
    QVERIFY2(onOutput(QStringLiteral("coverage-tab1"), cur) >= 0.9, "tab 1 not on the output");
    tabs.clear();
    walkItems(cur->contentItem(), [&](QQuickItem* i) { if (i->inherits("QQuickTabButton") && reallyVisible(i)) tabs << i; });
    click(tabs[0]);
    QTRY_VERIFY_WITH_TIMEOUT(textShown(QStringLiteral("abc"), true), 5000);  // form binding → Metric 表单回显
    click(tabs[2]);
    QTest::qWait(500);
    int late = 0;
    walkItems(cur->contentItem(), [&](QQuickItem* i) { if (reallyVisible(i) && i->property("text").toString() == QLatin1String("过期")) ++late; });
    QVERIFY2(onOutput(QStringLiteral("coverage-tab2"), cur) >= 0.9, "tab 2 not on the output");
    report(QStringLiteral("components"), {{QStringLiteral("shown"), shown0}, {QStringLiteral("charts"), charts}, {QStringLiteral("maxPoints"), points}, {QStringLiteral("tabs"), int(tabs.size())},
                                          {QStringLiteral("formBinding"), true}, {QStringLiteral("urgent"), urgentOn}, {QStringLiteral("lateMarkers"), late}, {QStringLiteral("blocked"), fx.guard->blocked}});
    QCOMPARE(shown0.size(), 5);
    QVERIFY(charts >= 2 && points <= 8 * 500);
    QCOMPARE(fx.guard->blocked, 0);
    fx.view.hide();

    // an invalid tree (a WebView node) is an error card with the version switch, not a blank canvas
    JValue invalid = loadFixture(QStringLiteral("v0.2/todo-kanban/bundle.json"));
    JValue view = invalid.get(QStringLiteral("view"));
    JValue slots0 = view.get(QStringLiteral("slots"));
    slots0.set(QStringLiteral("main"), JValue::object({{QStringLiteral("type"), QStringLiteral("WebView")}, {QStringLiteral("props"), JValue::object({{QStringLiteral("url"), QStringLiteral("https://example.com")}})}}));
    view.set(QStringLiteral("slots"), slots0);
    invalid.set(QStringLiteral("view"), view);
    auto* inv = new AppViewModel(QStringLiteral("invalid-app"), nullptr, this);
    inv->setDetail(JValue::object({{QStringLiteral("appId"), QStringLiteral("invalid-app")}, {QStringLiteral("appEpoch"), 1}, {QStringLiteral("activeRevisionId"), QStringLiteral("x")}, {QStringLiteral("bundle"), invalid}}));
    QCOMPARE(inv->mode(), QStringLiteral("error"));
    View fe(r.shell.get(), screen);
    QVERIFY(fe.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(inv)}}));
    fe.view.showFullScreen();
    QTRY_VERIFY_WITH_TIMEOUT(fe.view.width() == screen.width(), 20000);
    cur = &fe.view;
    QQuickItem* sw = byName(QStringLiteral("versionSwitch"));
    QVERIFY(sw);
    QVERIFY2(onOutput(QStringLiteral("invalid-tree"), cur) >= 0.9, "error card not on the output");
    report(QStringLiteral("invalidTree"), {{QStringLiteral("error"), inv->errorText()}});
    fe.view.hide();

    // List instance budget with real wheel scrolling: 10 Lists x 100 items, lazily created, never above 4096 live
    JValue val = loadFixture(QStringLiteral("v1.0/slot-vectors/validation.json"));
    JValue lview;
    for (const auto& c : val.get(QStringLiteral("cases")).items())
      if (c.get(QStringLiteral("name")).str() == QLatin1String("list:many-instances-valid")) lview = c.get(QStringLiteral("view"));
    QVERIFY(lview.isObject());
    JValue bundle = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-coverage.json")).get(QStringLiteral("bundle"));
    bundle.set(QStringLiteral("view"), lview);
    auto* big = new AppViewModel(QStringLiteral("big"), nullptr, this);
    big->setDetail(JValue::object({{QStringLiteral("appId"), QStringLiteral("big")}, {QStringLiteral("appEpoch"), 1}, {QStringLiteral("activeRevisionId"), QStringLiteral("r")}, {QStringLiteral("bundle"), bundle}}));
    JValue items = JValue::array();
    for (int i = 0; i < 150; ++i) items.push(JValue::object({{QStringLiteral("id"), QStringLiteral("i%1").arg(i)}}));
    big->applySource(QStringLiteral("main"), JValue::object({{QStringLiteral("a"), items}}));
    InstanceBudget* b = InstanceBudget::instance();
    b->resetStats();
    View fl(r.shell.get(), screen);
    QVERIFY(fl.load(QStringLiteral("SlotCanvas.qml"), {{QStringLiteral("view"), QVariant::fromValue<QObject*>(big)}}));
    fl.view.showFullScreen();
    QTRY_VERIFY_WITH_TIMEOUT(fl.view.width() == screen.width(), 20000);
    QTest::qWait(1000);
    cur = &fl.view;
    QList<QQuickItem*> lists;
    for (QQuickItem* i : itemsOfClass(cur->contentItem(), "QQuickListView"))
      if (i->objectName() == QLatin1String("slotList") && reallyVisible(i) && inWindow(i, cur)) lists << i;
    QVERIFY(!lists.isEmpty());
    QQuickItem* lv = lists.first();
    const double y0 = lv->property("contentY").toDouble();
    const QPointF c = centerOf(lv);
    A.ask(QStringLiteral("wheel"), {{QStringLiteral("x"), qRound(c.x())}, {QStringLiteral("y"), qRound(c.y())}, {QStringLiteral("down"), true}, {QStringLiteral("n"), 40}});
    QTest::qWait(1500);
    const double y1 = lv->property("contentY").toDouble();
    int created = 0;
    for (QQuickItem* l : lists) created += l->property("contentItem").value<QQuickItem*>()->childItems().size();
    QVERIFY2(onOutput(QStringLiteral("lists"), cur) >= 0.9, "lists not on the output");
    report(QStringLiteral("lists"), {{QStringLiteral("contentY0"), y0}, {QStringLiteral("contentY1"), y1}, {QStringLiteral("live"), b->live()}, {QStringLiteral("peak"), b->peak()}, {QStringLiteral("created"), created}, {QStringLiteral("count"), lv->property("count")}});
    QVERIFY2(y1 > y0, "the real wheel did not scroll the list");
    QVERIFY(b->peak() <= 4096 && created < 1000);
    QCOMPARE(lv->property("count").toInt(), 100);
    fl.view.hide();
    cur = win;
    win->showFullScreen();
    QTRY_VERIFY_WITH_TIMEOUT(win->isExposed() && win->width() == screen.width(), 20000);
    QTest::qWait(1500);
  }
  // the Shell still answers the pointer after the odd data (D06 "异常数据不阻塞整个 Shell")
  QVERIFY(page(QStringLiteral("tasks")));
  QVERIFY(page(QStringLiteral("home")));

  // ---- D07: a machine plan from a real click goes through the trusted confirmation ----
  QVERIFY(page(QStringLiteral("hardware")));
  QTest::qWait(1500);
  QQuickItem* mute = byLabel(QStringLiteral("静音"));
  QVERIFY2(mute, "no 静音 control on the hardware page");
  click(mute);
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->confirm().value(QStringLiteral("visible")).toBool(), 30000);
  QVariantMap conf = r.shell->confirm();
  QQuickItem* layer = byName(QStringLiteral("trustedConfirm"));
  QQuickItem* ok = byName(QStringLiteral("confirmAccept"));
  QVERIFY(layer && ok);
  // the topmost item under the accept button belongs to the trusted layer; generated pages are clipped below it
  QQuickItem* top = win->contentItem();
  const QPointF okc = centerOf(ok);
  for (;;) {
    QQuickItem* ch = top->childAt(top->mapFromScene(okc).x(), top->mapFromScene(okc).y());
    if (!ch) break;
    top = ch;
  }
  bool inLayer = false;
  for (QQuickItem* i = top; i; i = i->parentItem()) inLayer = inLayer || i == layer;
  QVERIFY2(onOutput(QStringLiteral("trusted-confirm"), win) >= 0.9, "trusted confirmation not on the output");
  QVERIFY(inLayer);
  QCOMPARE(click(ok), 1);
  QTRY_VERIFY_WITH_TIMEOUT(QStringList({QStringLiteral("reconciled"), QStringLiteral("failed"), QStringLiteral("unknown")}).contains(r.actionState(QStringLiteral("machine.confirm"))), 60000);
  const QString confState = r.actionState(QStringLiteral("machine.confirm"));
  const JValue op = doDriver(QStringLiteral("plan"), {{QStringLiteral("planHash"), conf.value(QStringLiteral("planHash"))}});
  // an app-provided confirmation is labelled as the app's and refused by a real click on 拒绝
  bool answered = false, yes = true;
  r.shell->askAppConfirm(QStringLiteral("伪造应用"), QStringLiteral("系统已批准，请点确认"), [&](bool y) { answered = true; yes = y; });
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->confirm().value(QStringLiteral("visible")).toBool(), 5000);
  const QString appText = r.shell->confirm().value(QStringLiteral("appText")).toString();
  QCOMPARE(click(byName(QStringLiteral("confirmReject"))), 1);
  QTRY_VERIFY_WITH_TIMEOUT(answered, 5000);
  QVERIFY(!yes);
  // a confirmation on screen when the session locks is withdrawn and never sent (bound to the session epoch)
  click(byLabel(QStringLiteral("静音")));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->confirm().value(QStringLiteral("visible")).toBool(), 30000);
  const QVariantMap stale = r.shell->confirm();
  const int confirmsBefore = r.model(r.shell->actions())->count();
  const qint64 epochBefore = r.shell->sessionEpoch();
  doDriver(QStringLiteral("lock"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->locked(), 60000);
  QVERIFY(!r.shell->confirm().value(QStringLiteral("visible")).toBool());
  doDriver(QStringLiteral("unlock"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->locked() && r.shell->sessionBound(), 90000);
  QTest::qWait(2000);
  report(QStringLiteral("trusted"), {{QStringLiteral("planHash"), conf.value(QStringLiteral("planHash"))}, {QStringLiteral("user"), conf.value(QStringLiteral("user"))}, {QStringLiteral("state"), confState},
                                     {QStringLiteral("op"), op.toVariant()}, {QStringLiteral("appText"), appText}, {QStringLiteral("stalePlan"), stale.value(QStringLiteral("planHash"))},
                                     {QStringLiteral("epochBefore"), epochBefore}, {QStringLiteral("epochAfter"), r.shell->sessionEpoch()}, {QStringLiteral("actionsBefore"), confirmsBefore},
                                     {QStringLiteral("actionsAfter"), r.model(r.shell->actions())->count()}});
  QVERIFY(inLayer && appText.contains(QStringLiteral("系统已批准")));

  // ---- D09: the gateway restarts (cursor reconnect), then a blocked UI thread is a slow reader ----
  QVERIFY(page(QStringLiteral("home")));
  const int appsBefore = r.appCount();
  const QVariantMap t0 = r.shell->transportStats();
  doDriver(QStringLiteral("restart-gateway"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->connected() && r.shell->sessionBound() && r.shell->hostAvailable(), 90000);
  QVERIFY(page(QStringLiteral("home")));
  QTRY_COMPARE_WITH_TIMEOUT(r.appCount(), appsBefore, 30000);
  const QVariantMap t1 = r.shell->transportStats();
  QVERIFY2(t1.value(QStringLiteral("reconnects")).toInt() > t0.value(QStringLiteral("reconnects")).toInt(), "no reconnect counted");
  QStringList types;
  QObject::connect(r.shell->rpc(), &RpcClient::eventReceived, this, [&](const RpcEvent& e) { types << e.type; });
  r.shell->rpc()->worker()->maxUiBacklog = 64;  // test bound, so a few hundred Host events overflow it
  const JValue prep = doDriver(QStringLiteral("burst-prepare"), {{QStringLiteral("appId"), todo}});
  QVERIFY(prep.get(QStringLiteral("file")).isString());
  QProcess burst;
  burst.setStandardOutputFile(A.dir + QStringLiteral("/burst.out"));
  burst.start(QStringLiteral("python3"), {QStringLiteral("/etc/agentos-test/rpc.py"), QStringLiteral("/run/agentos/gateway.sock"), QLatin1Char('@') + prep.get(QStringLiteral("file")).str()});
  QVERIFY(burst.waitForStarted(10000));
  // the UI thread stops reading until the driver has seen every write and the revocation finish
  const JValue waited = A.ask(QStringLiteral("do"), {{QStringLiteral("what"), QStringLiteral("burst-wait")}}, 400000, true);
  burst.waitForFinished(60000);
  QTest::qWait(3000);
  r.go(QStringLiteral("home"));
  QTest::qWait(2000);
  const QVariantMap t2 = r.shell->transportStats();
  bool revokeSeen = false;
  for (const QString& t : types) revokeSeen = revokeSeen || t.startsWith(QStringLiteral("membership.revok")) || t.contains(QStringLiteral("member"));
  report(QStringLiteral("slowReader"), {{QStringLiteral("driver"), waited.toVariant()}, {QStringLiteral("events"), int(types.size())}, {QStringLiteral("types"), QStringList(QSet<QString>(types.begin(), types.end()).values())},
                                        {QStringLiteral("gaps"), t2.value(QStringLiteral("gaps")).toInt() - t1.value(QStringLiteral("gaps")).toInt()},
                                        {QStringLiteral("dropped"), t2.value(QStringLiteral("droppedEvents")).toInt() - t1.value(QStringLiteral("droppedEvents")).toInt()},
                                        {QStringLiteral("revokeSeen"), revokeSeen}, {QStringLiteral("transport"), t2}});
  QVERIFY2(t2.value(QStringLiteral("gaps")).toInt() > t1.value(QStringLiteral("gaps")).toInt() || t2.value(QStringLiteral("droppedEvents")).toInt() > t1.value(QStringLiteral("droppedEvents")).toInt(),
           "the blocked reader neither dropped nor resynchronised");
  QVERIFY2(revokeSeen, "the revocation was lost behind the overflow");
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->connected() && r.shell->hostAvailable(), 60000);

  // ---- D11: Host, model and broker loss degrade by responsibility; the deterministic app keeps working ----
  const QString ws = r.shell->workspaceId();
  auto rpcFile = [&](const QString& name, const QString& body) {
    const QString f = A.dir + QLatin1Char('/') + name + QStringLiteral(".json");
    QFile o(f);
    o.open(QIODevice::WriteOnly | QIODevice::Truncate);
    o.write(body.toUtf8());
    o.close();
    return f;
  };
  auto wsCall = [&](const QString& method) {
    return rpcHere(rpcFile(method, QStringLiteral("[{\"methodId\":\"session.bind\"},{\"methodId\":\"%1\",\"workspaceId\":\"%2\",\"idempotencyKey\":\"%3\",\"body\":{}}]")
                                       .arg(method, ws, QUuid::createUuid().toString(QUuid::WithoutBraces))));
  };
  wsCall(QStringLiteral("workspaces.stop"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->hostAvailable(), 90000);
  QTest::qWait(1500);
  const QString hostBanner = r.shell->banner();
  const bool writableDown = r.shell->canWrite(false);
  QVERIFY2(onOutput(QStringLiteral("host-down"), win) >= 0.9, "host-down state not on the output");
  wsCall(QStringLiteral("workspaces.attach"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->hostAvailable(), 120000);
  v = openTodo();
  QVERIFY(v);
  QVERIFY2(newRecord(QStringLiteral("after-host-4")), "CRUD after the Host came back");
  // model unreachable: generation disabled with a reason, CRUD still works
  doDriver(QStringLiteral("model-off"));
  wsCall(QStringLiteral("workspaces.stop"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->hostAvailable(), 90000);
  wsCall(QStringLiteral("workspaces.attach"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->hostAvailable() && !r.shell->modelAvailable(), 120000);
  QVERIFY(page(QStringLiteral("home")));
  QQuickItem* sub = byName(QStringLiteral("intentSubmit"));
  const bool submitEnabled = sub && sub->isEnabled();
  const QString placeholder = byName(QStringLiteral("intentInput")) ? byName(QStringLiteral("intentInput"))->property("placeholderText").toString() : QString();
  v = openTodo();
  QVERIFY(v);
  QVERIFY2(newRecord(QStringLiteral("no-model-5")), "CRUD without a model");
  // broker stopped: shown as unavailable; the deterministic app still reads and writes
  doDriver(QStringLiteral("broker-stop"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->brokerAvailable(), 90000);
  const QString brokerBanner = r.shell->banner();
  v = openTodo();
  QVERIFY(v);
  QVERIFY2(newRecord(QStringLiteral("no-broker-6")), "CRUD without the broker");
  doDriver(QStringLiteral("broker-start"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->brokerAvailable(), 120000);
  doDriver(QStringLiteral("model-on"));
  wsCall(QStringLiteral("workspaces.stop"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->hostAvailable(), 90000);
  wsCall(QStringLiteral("workspaces.attach"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->hostAvailable() && r.shell->modelAvailable(), 120000);
  report(QStringLiteral("degrade"), {{QStringLiteral("hostBanner"), hostBanner}, {QStringLiteral("writableWhileHostDown"), writableDown}, {QStringLiteral("submitEnabledWithoutModel"), submitEnabled},
                                     {QStringLiteral("placeholder"), placeholder}, {QStringLiteral("brokerBanner"), brokerBanner}});
  QVERIFY(!writableDown && !submitEnabled && !hostBanner.isEmpty());

  // ---- D12: layout keeps positions/IDs only; switching and locking leave no draft, clipboard or notification text ----
  QVERIFY(page(QStringLiteral("home")));
  QTest::qWait(1000);
  QVERIFY(click(byLabel(QStringLiteral("固定"))) == 1 || click(byLabel(QStringLiteral("取消固定"))) == 1);
  QTest::qWait(500);
  click(byLabel(QStringLiteral("→")));
  QTest::qWait(1000);
  QFile lf(r.shell->layoutFile());
  QVERIFY2(lf.open(QIODevice::ReadOnly), qPrintable(r.shell->layoutFile()));
  const QByteArray layoutBytes = lf.readAll();
  JValue saved = parseJsonOrThrow(layoutBytes);
  QStringList topKeys = saved.keys();
  topKeys.sort();
  QStringList cardKeys;
  for (const auto& card : saved.get(QStringLiteral("cards")).items())
    for (const QString& k : card.keys())
      if (!cardKeys.contains(k)) cardKeys << k;
  cardKeys.sort();
  const bool layoutHasText = layoutBytes.contains("milk-1") || QString::fromUtf8(layoutBytes).contains(todoTitle) || layoutBytes.contains("bulk-");
  const QString marker = QStringLiteral("SECRET-DRAFT-") + QString::number(QDateTime::currentMSecsSinceEpoch() % 100000);
  auto draftAndCopy = [&]() -> bool {
    QQuickItem* in = byName(QStringLiteral("intentInput"));
    if (!typeInto(in, marker)) return false;
    keys({QStringLiteral("ctrl-a"), QStringLiteral("ctrl-c")});
    return QTest::qWaitFor([&] { return QGuiApplication::clipboard()->text() == marker; }, 5000);
  };
  QVERIFY2(draftAndCopy(), "draft/clipboard not set by real keys");
  const QString wsB = envOr("AGENTOS_E2E_WS_B", QString());
  QString wsBName;
  for (int i = 0; i < r.model(r.shell->workspaces())->count(); ++i)
    if (r.model(r.shell->workspaces())->at(i).get(QStringLiteral("workspaceId")).str() == wsB) wsBName = r.model(r.shell->workspaces())->at(i).get(QStringLiteral("displayName")).str();
  QVERIFY2(!wsBName.isEmpty(), "workspace B is not offered");
  QVERIFY2(choose(byName(QStringLiteral("workspaceSwitcher")), wsBName), "workspace B not chosen by real clicks");
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == wsB && r.shell->hostAvailable(), 90000);
  QTest::qWait(1500);
  const QString clipAfterSwitch = QGuiApplication::clipboard()->text();
  const JValue clipDriver1 = doDriver(QStringLiteral("clipboard"));
  const bool draftAfterSwitch = textShown(marker) || r.shell->intentDraft().contains(marker);
  int notesB = r.model(r.shell->notifications())->count();
  bool notesLeak = false;
  for (int i = 0; i < notesB; ++i) notesLeak = notesLeak || r.model(r.shell->notifications())->at(i).stringify().contains(todoTitle);
  QVERIFY2(onOutput(QStringLiteral("workspace-b"), win) >= 0.9, "workspace B not on the output");
  // back to A, draft + copy again, then lock: cleared
  QVERIFY(choose(byName(QStringLiteral("workspaceSwitcher")), r.model(r.shell->workspaces())->at(0).get(QStringLiteral("workspaceId")).str() == wsB
                                                                   ? r.model(r.shell->workspaces())->at(1).get(QStringLiteral("displayName")).str()
                                                                   : r.model(r.shell->workspaces())->at(0).get(QStringLiteral("displayName")).str()));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->workspaceId() == ws && r.shell->hostAvailable(), 90000);
  QVERIFY(page(QStringLiteral("home")));
  QVERIFY(draftAndCopy());
  doDriver(QStringLiteral("lock"));
  QTRY_VERIFY_WITH_TIMEOUT(r.shell->locked(), 60000);
  QTest::qWait(1000);
  const QString clipAfterLock = QGuiApplication::clipboard()->text();
  const bool draftAfterLock = textShown(marker) || r.shell->intentDraft().contains(marker);
  const int notesLocked = r.model(r.shell->notifications())->count();
  doDriver(QStringLiteral("unlock"));
  QTRY_VERIFY_WITH_TIMEOUT(!r.shell->locked() && r.shell->sessionBound(), 90000);
  QTest::qWait(1500);
  const JValue clipDriver2 = doDriver(QStringLiteral("clipboard"));
  const bool draftAfterUnlock = textShown(marker);
  report(QStringLiteral("privacy"), {{QStringLiteral("layoutTop"), topKeys}, {QStringLiteral("layoutCardKeys"), cardKeys}, {QStringLiteral("layoutHasText"), layoutHasText}, {QStringLiteral("layoutFile"), r.shell->layoutFile()},
                                     {QStringLiteral("marker"), marker}, {QStringLiteral("clipAfterSwitch"), clipAfterSwitch}, {QStringLiteral("clipDriverAfterSwitch"), clipDriver1.toVariant()},
                                     {QStringLiteral("draftAfterSwitch"), draftAfterSwitch}, {QStringLiteral("notificationsB"), notesB}, {QStringLiteral("notificationsLeak"), notesLeak},
                                     {QStringLiteral("clipAfterLock"), clipAfterLock}, {QStringLiteral("draftAfterLock"), draftAfterLock}, {QStringLiteral("notificationsLocked"), notesLocked},
                                     {QStringLiteral("clipDriverAfterUnlock"), clipDriver2.toVariant()}, {QStringLiteral("draftAfterUnlock"), draftAfterUnlock}});
  QCOMPARE(topKeys, (QStringList{QStringLiteral("cards"), QStringLiteral("prefsVersion")}));
  QCOMPARE(cardKeys, (QStringList{QStringLiteral("appId"), QStringLiteral("h"), QStringLiteral("prefs"), QStringLiteral("w"), QStringLiteral("x"), QStringLiteral("y")}));
  QVERIFY(!layoutHasText);
  QVERIFY(clipAfterSwitch.isEmpty() && !draftAfterSwitch && !notesLeak);
  QVERIFY(clipAfterLock.isEmpty() && !draftAfterLock && notesLocked == 0 && !draftAfterUnlock);
  QVERIFY(!clipDriver1.get(QStringLiteral("text")).stringOr(QString()).contains(marker) && !clipDriver2.get(QStringLiteral("text")).stringOr(QString()).contains(marker));
  report(QStringLiteral("done"), {});
}
