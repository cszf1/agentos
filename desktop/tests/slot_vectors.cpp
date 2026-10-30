// Semantic vectors (spec §10.3): replays fixtures/v1.0/slot-vectors/*.json (generated from the TS contracts by
// scripts/slot-vectors.mjs) through the C++ renderer core and compares semantics, not pixels.
#include "error_policy.hpp"
#include "jvalue.hpp"
#include "records_view.hpp"
#include "routes.hpp"
#include "shell_actions.hpp"
#include "slot_runtime.hpp"
#include "slot_validator.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QtTest/QtTest>

using namespace agentos;

static QString fixturesDir() { return QString::fromUtf8(AGENTOS_FIXTURES); }
static JValue loadJson(const QString& rel) {
  QFile f(fixturesDir() + QLatin1Char('/') + rel);
  if (!f.open(QIODevice::ReadOnly)) qFatal("cannot open %s", qPrintable(f.fileName()));
  return parseJsonOrThrow(f.readAll(), {128, 64 * 1024 * 1024});
}
static JValue embedded(const QString& name) {
  QFile f(QStringLiteral(":/agentos/renderer/") + name);
  if (!f.open(QIODevice::ReadOnly)) qFatal("missing resource %s", qPrintable(name));
  return parseJsonOrThrow(f.readAll(), {128, 64 * 1024 * 1024});
}
static QByteArray show(const JValue& v) { return v.stringify().left(1600).toUtf8(); }

/** Maps the TS key labels (k1, k2, …) onto the C++ uuids, checking it is a bijection. */
struct KeyMap {
  QMap<QString, QString> fwd, back;
  bool same(const QString& label, const QString& actual) {
    if (fwd.contains(label)) return fwd[label] == actual;
    if (back.contains(actual)) return false;
    fwd[label] = actual;
    back[actual] = label;
    return true;
  }
};

/** Compare expected (TS) and actual (C++) JSON; request idempotency keys go through the key map. */
static bool sameValue(const JValue& exp, const JValue& act, KeyMap& keys, QString path, QString* where) {
  if (exp.isObject() && act.isObject()) {
    for (const auto& m : exp.members()) {
      const JValue* a = act.find(m.first);
      const QString p = path + QLatin1Char('/') + m.first;
      if (m.first == QLatin1String("idempotencyKey") && m.second.isString() && a && a->isString()) {
        if (m.second.str().startsWith(QLatin1String("q:"))) continue;  // per-request read keys
        if (!keys.same(m.second.str(), a->str())) {
          *where = p + QStringLiteral(" key ") + m.second.str() + QStringLiteral(" vs ") + a->str();
          return false;
        }
        continue;
      }
      if (!a) {
        if (m.second.isMissing()) continue;
        *where = p + QStringLiteral(" missing in C++");
        return false;
      }
      if (!sameValue(m.second, *a, keys, p, where)) return false;
    }
    for (const auto& m : act.members())
      if (!exp.has(m.first) && !m.second.isMissing()) {
        *where = path + QLatin1Char('/') + m.first + QStringLiteral(" extra in C++");
        return false;
      }
    return true;
  }
  if (exp.isArray() && act.isArray()) {
    if (exp.size() != act.size()) {
      *where = path + QStringLiteral(" length %1 vs %2").arg(exp.size()).arg(act.size());
      return false;
    }
    for (int i = 0; i < exp.size(); ++i)
      if (!sameValue(exp.at(i), act.at(i), keys, path + QLatin1Char('/') + QString::number(i), where)) return false;
    return true;
  }
  if (exp.isNumber() && act.isNumber() && exp.toNumber() == act.toNumber()) return true;
  if (!exp.deepEquals(act)) {
    *where = path + QStringLiteral(": expected ") + exp.stringify().left(300) + QStringLiteral(" got ") + act.stringify().left(300);
    return false;
  }
  return true;
}

class SlotVectors : public QObject {
  Q_OBJECT
 private slots:
  void embeddedCopiesMatchContracts() {
    for (const auto& [fix, emb] : {std::pair{"schemas.json", "slot-schemas.json"}, std::pair{"error-policy.json", "error-policy.json"}, std::pair{"routes.json", "routes.json"}}) {
      JValue a = loadJson(QStringLiteral("v1.0/slot-vectors/") + QString::fromLatin1(fix));
      JValue b = embedded(QString::fromLatin1(emb));
      QVERIFY2(a.deepEquals(b), fix);
    }
  }

  void validationVerdicts() {
    JValue v = loadJson(QStringLiteral("v1.0/slot-vectors/validation.json"));
    int n = 0;
    for (const auto& c : v.get(QStringLiteral("cases")).items()) {
      SlotTreeContext ctx;
      ctx.queries = JValue::object();
      for (const auto& q : c.get(QStringLiteral("ctx")).get(QStringLiteral("queries")).items()) ctx.queries.set(q.str(), JValue::object());
      ctx.commands = JValue::object();
      for (const auto& q : c.get(QStringLiteral("ctx")).get(QStringLiteral("commands")).items()) ctx.commands.set(q.str(), JValue::object());
      const JValue& sa = c.get(QStringLiteral("ctx")).get(QStringLiteral("systemActions"));
      if (sa.isArray()) {
        ctx.systemActions = JValue::object();
        for (const auto& q : sa.items()) ctx.systemActions.set(q.str(), JValue::object());
      }
      ctx.viewKind = c.get(QStringLiteral("ctx")).get(QStringLiteral("viewKind")).str();
      auto issues = checkSlotTree(c.get(QStringLiteral("view")), ctx);
      JValue got = JValue::array();
      for (const auto& i : issues) {
        QString p = i.path;
        if (i.message.contains(QRegularExpression(QStringLiteral("^[A-Za-z]+: "))) && p.contains(QStringLiteral("/props"))) p = p.left(p.indexOf(QStringLiteral("/props"))) + QStringLiteral("/props");
        got.push(JValue::object({{QStringLiteral("path"), p}, {QStringLiteral("code"), i.code}}));
      }
      const QString name = c.get(QStringLiteral("name")).str();
      QVERIFY2(got.deepEquals(c.get(QStringLiteral("issues"))), qPrintable(name + QStringLiteral(": expected ") + c.get(QStringLiteral("issues")).stringify() + QStringLiteral(" got ") + got.stringify()));
      QCOMPARE(issues.isEmpty(), c.get(QStringLiteral("valid")).toBool());
      n++;
    }
    QVERIFY(n >= 60);
  }

  void pointersTextsNumbers() {
    JValue v = loadJson(QStringLiteral("v1.0/slot-vectors/values.json"));
    const JValue& data = v.get(QStringLiteral("pointerData"));
    for (const auto& c : v.get(QStringLiteral("pointers")).items()) {
      JValue got = encodeMissing(readPointer(data, c.get(QStringLiteral("pointer")).str()));
      QVERIFY2(got.deepEquals(c.get(QStringLiteral("result"))), qPrintable(c.get(QStringLiteral("pointer")).str() + QStringLiteral(" -> ") + got.stringify()));
    }
    for (const auto& c : v.get(QStringLiteral("texts")).items()) {
      JValue val = c.get(QStringLiteral("missing")).toBool() ? JValue() : c.get(QStringLiteral("value"));
      QCOMPARE(asText(val), c.get(QStringLiteral("text")).str());
    }
    for (const auto& c : v.get(QStringLiteral("numbers")).items()) {
      const QString raw = c.get(QStringLiteral("raw")).str();
      JValue stored;
      if (!jsTrim(raw).isEmpty()) {
        JValue n(jsStringToNumber(raw));
        stored = n.isSafeInteger() ? n : JValue(raw);
      }
      QVERIFY2(encodeMissing(stored).deepEquals(c.get(QStringLiteral("stored"))), qPrintable(raw + QStringLiteral(" -> ") + encodeMissing(stored).stringify()));
      QCOMPARE(stored.isNullish() ? QString() : asText(stored), c.get(QStringLiteral("display")).str());
    }
    for (const auto& c : v.get(QStringLiteral("lengths")).items()) QCOMPARE(codePointLength(c.get(QStringLiteral("s")).str()), int(c.get(QStringLiteral("codePoints")).toNumber()));
  }

  void scenarios_data() {
    QTest::addColumn<QString>("file");
    for (const QString& f : QDir(fixturesDir() + QStringLiteral("/v1.0/slot-vectors")).entryList({QStringLiteral("scenario-*.json")})) QTest::newRow(qPrintable(f)) << f;
  }
  void scenarios() {
    QFETCH(QString, file);
    JValue sc = loadJson(QStringLiteral("v1.0/slot-vectors/") + file);
    const JValue& a = sc.get(QStringLiteral("app"));
    AppIdentity app{a.get(QStringLiteral("appId")).str(), a.get(QStringLiteral("appEpoch")).toNumber(), a.get(QStringLiteral("revisionId")).str()};
    SlotRuntime rt;
    QCOMPARE(rt.load(sc.get(QStringLiteral("bundle")), app), sc.get(QStringLiteral("validation")).get(QStringLiteral("valid")).toBool());
    KeyMap keys;
    int i = 0;
    for (const auto& st : sc.get(QStringLiteral("steps")).items()) {
      const QString op = st.get(QStringLiteral("op")).str();
      JValue result = JValue::null();
      QString error;
      auto S = [&](const char* k) { return st.get(QString::fromLatin1(k)).str(); };
      try {
        if (op == QLatin1String("init")) {
        } else if (op == QLatin1String("load")) {
          result = rt.applyQuery(S("source"), decodeMissing(st.get(QStringLiteral("output"))), S("revisionId"), st.get(QStringLiteral("appEpoch")).toNumber());
        } else if (op == QLatin1String("type")) rt.typeText(S("formId"), S("name"), S("raw"));
        else if (op == QLatin1String("choose")) rt.choose(S("formId"), S("name"), S("value"));
        else if (op == QLatin1String("check")) rt.check(S("formId"), S("name"), st.get(QStringLiteral("on")).toBool());
        else if (op == QLatin1String("toggle")) rt.toggle(S("selectionId"), S("id"), st.get(QStringLiteral("on")).toBool());
        else if (op == QLatin1String("page")) rt.setPage(S("path"), int(st.get(QStringLiteral("page")).toNumber()));
        else if (op == QLatin1String("tab")) rt.setTab(S("path"), int(st.get(QStringLiteral("index")).toNumber()));
        else if (op == QLatin1String("click")) result = rt.click(S("path")).toJson();
        else if (op == QLatin1String("confirm")) result = rt.confirm(st.get(QStringLiteral("accept")).toBool()).toJson();
        else if (op == QLatin1String("respond")) result = rt.respond(Outcome::fromJson(st.get(QStringLiteral("outcome")))).toJson();
        else if (op == QLatin1String("switchRevision")) {
          const JValue& na = st.get(QStringLiteral("app"));
          rt.switchRevision(st.get(QStringLiteral("bundle")), {na.get(QStringLiteral("appId")).str(), na.get(QStringLiteral("appEpoch")).toNumber(), na.get(QStringLiteral("revisionId")).str()});
        } else if (op == QLatin1String("confirmNewVersion")) rt.confirmNewVersion();
        else if (op == QLatin1String("clearScope")) rt.clearScope();
        else if (op == QLatin1String("queries")) {
          result = JValue::array();
          for (const auto& q : rt.queryRequests()) result.push(q.toJson());
        } else QFAIL(qPrintable(QStringLiteral("unknown op ") + op));
      } catch (const std::exception& e) {
        error = QString::fromUtf8(e.what());
      }
      const JValue& exp = st.get(QStringLiteral("expect"));
      const QString tag = file + QStringLiteral(" step %1 (%2 %3)").arg(i).arg(op, st.get(QStringLiteral("path")).stringOr(QString()));
      QCOMPARE(error.isEmpty(), exp.get(QStringLiteral("error")).isNull());
      if (!error.isEmpty()) QCOMPARE(error, exp.get(QStringLiteral("error")).str());
      QString where;
      QVERIFY2(sameValue(decodeMissing(exp.get(QStringLiteral("result"))), result, keys, QStringLiteral("result"), &where), qPrintable(tag + QStringLiteral(" ") + where));
      QVERIFY2(sameValue(exp.get(QStringLiteral("snapshot")), rt.render(), keys, QStringLiteral("snapshot"), &where), qPrintable(tag + QStringLiteral(" ") + where));
      QVERIFY2(sameValue(exp.get(QStringLiteral("forms")), rt.formsSnapshot(), keys, QStringLiteral("forms"), &where), qPrintable(tag + QStringLiteral(" ") + where));
      QVERIFY2(sameValue(exp.get(QStringLiteral("selections")), rt.selectionsSnapshot(), keys, QStringLiteral("selections"), &where), qPrintable(tag + QStringLiteral(" ") + where));
      QVERIFY2(sameValue(exp.get(QStringLiteral("notice")), rt.notice().toJson(), keys, QStringLiteral("notice"), &where), qPrintable(tag + QStringLiteral(" ") + where));
      QCOMPARE(rt.busy(), exp.get(QStringLiteral("busy")).toBool());
      QCOMPARE(rt.staleInput(), exp.get(QStringLiteral("staleInput")).toBool());
      i++;
    }
    QVERIFY(i > 3);
  }

  void records() {
    JValue v = loadJson(QStringLiteral("v1.0/slot-vectors/records.json"));
    const QString appId = v.get(QStringLiteral("appId")).str();
    for (const auto& c0 : v.get(QStringLiteral("cases")).items()) {
      const JValue c = decodeMissing(c0);
      const JValue& in = c.get(QStringLiteral("input"));
      const QString op = in.get(QStringLiteral("op")).str();
      const JValue& b = in.get(QStringLiteral("bundle"));
      JValue got;
      auto num = [&](const char* k) { return in.get(QString::fromLatin1(k)).toNumber(); };
      if (op == QLatin1String("defaultDraft")) got = records::defaultDraft(b);
      else if (op == QLatin1String("list")) got = records::listRequest(appId, b, in.get(QStringLiteral("q")).str(), in.get(QStringLiteral("filters")), int(num("offset"))).toJson();
      else if (op == QLatin1String("changeFilter")) got = records::changeFilter(b, in.get(QStringLiteral("filters")), in.get(QStringLiteral("key")).str(), in.get(QStringLiteral("value")).str());
      else if (op == QLatin1String("keepFilters")) got = records::keepFilters(b, in.get(QStringLiteral("filters")));
      else if (op == QLatin1String("openEdit")) got = records::openEdit(b, in.get(QStringLiteral("data")));
      else if (op == QLatin1String("edit")) {
        auto r = records::editRequest(appId, num("appEpoch"), in.get(QStringLiteral("record")), in.get(QStringLiteral("draft")), QStringLiteral("k"));
        got = r ? r->toJson() : JValue::null();
      } else if (op == QLatin1String("create")) got = records::createRequest(appId, num("appEpoch"), in.get(QStringLiteral("draft")), QStringLiteral("k")).toJson();
      else if (op == QLatin1String("delete")) got = records::deleteRequest(appId, num("appEpoch"), in.get(QStringLiteral("record")), QStringLiteral("k")).toJson();
      else if (op == QLatin1String("rebase")) got = records::rebase(b, in.get(QStringLiteral("mode")).str(), in.get(QStringLiteral("draft")));
      else if (op == QLatin1String("deploy")) got = records::deployRequest(appId, num("appEpoch"), in.get(QStringLiteral("revisionId")).str(), QStringLiteral("k")).toJson();
      else if (op == QLatin1String("issues")) got = records::localIssues(b, in.get(QStringLiteral("draft")));
      else if (op == QLatin1String("fieldInput")) got = records::fieldInput(in.get(QStringLiteral("field")), in.get(QStringLiteral("raw")));
      else if (op == QLatin1String("display")) got = JValue(records::displayValue(in.get(QStringLiteral("field")), in.get(QStringLiteral("value"))));
      else if (op == QLatin1String("keyAfter")) got = JValue(records::keyAfter(in.get(QStringLiteral("outcome")).str()));
      else QFAIL(qPrintable(op));
      KeyMap keys;
      QString where;
      QVERIFY2(sameValue(c.get(QStringLiteral("output")), got, keys, QString(), &where), qPrintable(c.get(QStringLiteral("name")).str() + QStringLiteral(" ") + where));
    }
  }

  void shellActions() {
    JValue v = loadJson(QStringLiteral("v1.0/slot-vectors/shell-actions.json"));
    int n = 0;
    for (const auto& c : v.get(QStringLiteral("actions")).items()) {
      ShellRequest r = shellAction(c.get(QStringLiteral("name")).str(), c.get(QStringLiteral("args")));
      KeyMap keys;
      QString where;
      QVERIFY2(sameValue(c.get(QStringLiteral("request")), r.toJson(), keys, QString(), &where), qPrintable(c.get(QStringLiteral("name")).str() + QStringLiteral(" ") + where));
      n++;
    }
    QVERIFY(n >= 80);
    // every TS action exists in C++ and vice versa
    QSet<QString> ts;
    for (const auto& c : v.get(QStringLiteral("actions")).items()) ts.insert(c.get(QStringLiteral("name")).str());
    for (const QString& name : shellActionNames()) QVERIFY2(ts.contains(name), qPrintable(name));
    bool threw = false;
    try {
      shellAction(QStringLiteral("machine.plan"), JValue::object({{QStringLiteral("actionKind"), QStringLiteral("dbus.call")}}));
    } catch (const std::exception& e) {
      threw = true;
      QCOMPARE(QString::fromUtf8(e.what()), v.get(QStringLiteral("rejected")).get(QStringLiteral("error")).str());
    }
    QVERIFY(threw);
    for (const auto& c : v.get(QStringLiteral("states")).items()) QCOMPARE(displayState(c.get(QStringLiteral("input"))), c.get(QStringLiteral("state")).str());
    for (const auto& c : v.get(QStringLiteral("errors")).items()) {
      const QString code = c.get(QStringLiteral("code")).str();
      QCOMPARE(describeError(code, QString::fromUtf8("原始消息")), c.get(QStringLiteral("text")).str());
      QVERIFY2(errorPolicy(code).toJson().deepEquals(c.get(QStringLiteral("policy"))), qPrintable(code + QStringLiteral(" ") + errorPolicy(code).toJson().stringify()));
    }
  }
};

QTEST_GUILESS_MAIN(SlotVectors)
#include "slot_vectors.moc"
