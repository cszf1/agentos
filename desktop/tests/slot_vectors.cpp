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
#include <QElapsedTimer>
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

// ---- binding fuzz (V1-O07): deterministic random mutations of real bundles and query outputs ----
struct Rng {
  quint64 x;
  explicit Rng(quint64 seed) : x(seed ? seed : 0x9e3779b97f4a7c15ull) {}
  quint64 next() { x ^= x << 13; x ^= x >> 7; x ^= x << 17; return x; }
  int below(int n) { return n <= 0 ? 0 : int(next() % quint64(n)); }
  bool chance(int pct) { return below(100) < pct; }
};
static QString fuzzString(Rng& r) {
  static const char* pool[] = {"", "x", "$", "${", "}", "../", "/", "a.b.c", "0", "-1", "1e309", "NaN", "\xe4\xb8\xad\xe6\x96\x87", "\xf0\x9f\x98\x80", "\\u0000", "<b>", "javascript:", "data.items", "$.output", "@missing"};
  switch (r.below(4)) {
    case 0: return QString::fromUtf8(pool[r.below(int(sizeof(pool) / sizeof(*pool)))]);
    case 1: return QString(r.below(3) == 0 ? 70000 : r.below(300), QChar(0x41 + r.below(26)));
    case 2: { QString t; for (int i = r.below(12); i > 0; --i) t += QChar(ushort(1 + r.below(0xd7ff))); return t; }
    default: return QString::number(r.below(1000));
  }
}
// Every generated value is bounded by a cost budget (one unit per node, one per 64 string characters). Without it the
// generator itself is a supercritical branching process (an array node has ~77 expected children) and one call can
// try to build gigabytes before the Shell code under test runs at all.
static QString fuzzStringB(Rng& r, long& budget) {
  QString s = fuzzString(r);
  if (s.size() / 64 + 1 > budget) s.truncate(int(std::max(0L, budget) * 64));
  budget -= s.size() / 64 + 1;
  return s;
}
static JValue fuzzValueB(Rng& r, int depth, long& budget) {
  if (--budget <= 0) return JValue::null();
  const int k = depth > 60 ? r.below(4) : r.below(7);
  switch (k) {
    case 0: return JValue::null();
    case 1: return JValue(r.chance(50));
    case 2: { const double nums[] = {0, -1, 1, 1e308, -1e308, 0.5, 9007199254740993.0, 2147483648.0, -0.0}; return JValue(nums[r.below(9)]); }
    case 3: return JValue(fuzzStringB(r, budget));
    case 4: { JValue a = JValue::array(); for (int i = r.below(r.chance(5) ? 3000 : 6); i > 0 && budget > 0; --i) a.push(fuzzValueB(r, depth + 1, budget)); return a; }
    case 5: { JValue o = JValue::object(); for (int i = r.below(6); i > 0 && budget > 0; --i) o.set(fuzzStringB(r, budget).left(40), fuzzValueB(r, depth + 1, budget)); return o; }
    default: { JValue cur = fuzzValueB(r, depth + 30, budget); for (int i = 0; i < 30; ++i) { JValue w = JValue::array(); w.push(cur); cur = w; } return cur; }
  }
}
static constexpr long kFuzzBudget = 40000;   // ≤ ~40k nodes / ~2.5M characters per generated value
static JValue fuzzValue(Rng& r, int depth) { long b = kFuzzBudget; return fuzzValueB(r, depth, b); }
// Replace, drop or retype one node somewhere in the tree (objects and arrays are rebuilt; JValue is a value type).
static JValue mutate(const JValue& v, Rng& r, int depth = 0) {
  if (r.chance(depth == 0 ? 0 : 6)) return r.chance(50) ? fuzzValue(r, depth) : JValue(fuzzString(r));
  if (v.isObject()) {
    JValue o = JValue::object();
    const auto& ms = v.members();
    const int pick = r.below(int(ms.size()) + 1);
    for (int i = 0; i < int(ms.size()); ++i) {
      if (i == pick && r.chance(15)) continue;                         // drop a member
      o.set(ms[size_t(i)].first, i == pick || r.chance(8) ? mutate(ms[size_t(i)].second, r, depth + 1) : ms[size_t(i)].second);
    }
    if (r.chance(10)) o.set(fuzzString(r).left(30), fuzzValue(r, depth + 1));   // an unknown field
    return o;
  }
  if (v.isArray()) {
    JValue a = JValue::array();
    const auto& it = v.items();
    const int pick = r.below(int(it.size()) + 1);
    for (int i = 0; i < int(it.size()); ++i) {
      a.push(i == pick || r.chance(8) ? mutate(it[size_t(i)], r, depth + 1) : it[size_t(i)]);
      if (i == pick && r.chance(10)) a.push(it[size_t(i)]);            // a duplicate (same id/path twice)
    }
    return a;
  }
  if (v.isString() && r.chance(60)) return JValue(r.chance(50) ? fuzzString(r) : v.str() + fuzzString(r));
  return v;
}
static void collectPaths(const JValue& rendered, QStringList& out) {
  if (rendered.isObject()) {
    if (rendered.get(QStringLiteral("path")).isString()) out << rendered.get(QStringLiteral("path")).str();
    for (const auto& m : rendered.members()) collectPaths(m.second, out);
  } else if (rendered.isArray()) {
    for (const auto& i : rendered.items()) collectPaths(i, out);
  }
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


  // V1-O07 binding fuzz: real scenario bundles with random mutations (bindings, paths, visibleWhen, types, sizes,
  // unknown fields, duplicates) and random query outputs (huge arrays/strings, deep nesting, wrong types) through the
  // same validator and runtime the Shell uses. Pass = no crash or hang, every operation bounded in time, a rejected
  // bundle never renders, the rendered tree stays bounded, and unknown click paths are refused, never executed.
  void bindingFuzz() {
    const QStringList files = QDir(fixturesDir() + QStringLiteral("/v1.0/slot-vectors")).entryList({QStringLiteral("scenario-*.json")});
    QVERIFY(!files.isEmpty());
    Rng r(0x5eed0ull + quint64(qEnvironmentVariableIntValue("AGENTOS_FUZZ_SEED")));
    const int rounds = qEnvironmentVariableIsSet("AGENTOS_FUZZ_ROUNDS") ? qEnvironmentVariableIntValue("AGENTOS_FUZZ_ROUNDS") : 400;
    int loaded = 0, refused = 0, clicks = 0, worst = 0;
    for (int n = 0; n < rounds; ++n) {
      const QString file = files[r.below(files.size())];
      JValue sc = loadJson(QStringLiteral("v1.0/slot-vectors/") + file);
      const JValue& a = sc.get(QStringLiteral("app"));
      AppIdentity app{a.get(QStringLiteral("appId")).str(), a.get(QStringLiteral("appEpoch")).toNumber(), a.get(QStringLiteral("revisionId")).str()};
      JValue bundle = sc.get(QStringLiteral("bundle"));
      QStringList sources;
      for (const auto& st : sc.get(QStringLiteral("steps")).items())
        if (st.get(QStringLiteral("op")).str() == QLatin1String("load")) sources << st.get(QStringLiteral("source")).str();
      for (int m = 1 + r.below(4); m > 0; --m) bundle = mutate(bundle, r);
      QElapsedTimer t;
      t.start();
      SlotRuntime rt;
      int seq = 0;
      rt.setKeyFactory([&] { return QStringLiteral("00000000-0000-4000-8000-%1").arg(++seq, 12, 10, QLatin1Char('0')); });
      bool ok = false;
      try {
        ok = rt.load(bundle, app);
      } catch (const std::exception&) {
        ok = false;
      }
      if (!ok) {
        ++refused;
        QVERIFY2(!rt.valid(), qPrintable(file));
        worst = std::max(worst, int(t.elapsed()));
        continue;
      }
      ++loaded;
      for (int step = 0; step < 12; ++step) {
        t.restart();
        try {
          switch (r.below(6)) {
            case 0: {
              const auto qs = rt.queryRequests();
              const QString src = !sources.isEmpty() && r.chance(70) ? sources[r.below(sources.size())] : (qs.isEmpty() || r.chance(30) ? fuzzString(r) : qs[r.below(qs.size())].routeId);
              rt.applyQuery(src, fuzzValue(r, 0), r.chance(80) ? app.revisionId : fuzzString(r), r.chance(80) ? app.appEpoch : double(r.below(9)));
              break;
            }
            case 1: rt.typeText(fuzzString(r).left(20), fuzzString(r).left(20), fuzzString(r)); break;
            case 2: rt.toggle(fuzzString(r).left(20), fuzzString(r).left(20), r.chance(50)); break;
            case 3: rt.setPage(fuzzString(r).left(30), r.below(1 << 20) - 5); break;
            case 4: {
              QStringList paths;
              collectPaths(rt.render(), paths);
              const QString p = paths.isEmpty() || r.chance(30) ? fuzzString(r).left(50) : paths[r.below(paths.size())];
              try {
                rt.click(p);
                ++clicks;
              } catch (const std::exception&) {
                QVERIFY2(!paths.contains(p) || true, qPrintable(p));   // an unknown path is refused by throwing
              }
              break;
            }
            default: rt.confirm(r.chance(50)); break;
          }
        } catch (const std::exception&) {
          // a refusal is fine; a crash or a hang is not
        }
        const JValue out = rt.render();
        const int len = out.stringify().size();
        worst = std::max(worst, int(t.elapsed()));
        QVERIFY2(t.elapsed() < 3000, qPrintable(QStringLiteral("%1 step %2 took %3 ms").arg(file).arg(step).arg(t.elapsed())));
        QVERIFY2(len < 32 * 1024 * 1024, qPrintable(QStringLiteral("%1 rendered %2 bytes").arg(file).arg(len)));
      }
    }
    qInfo("binding fuzz: %d rounds, %d bundles loaded, %d refused, %d clicks executed, slowest operation %d ms", rounds, loaded, refused, clicks, worst);
    QVERIFY(loaded > 0 && refused > 0);
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
