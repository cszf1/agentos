#include "slot_runtime.hpp"

#include "error_policy.hpp"
#include "routes.hpp"

#include <QRegularExpression>
#include <QSet>
#include <QUuid>
#include <cmath>
#include <stdexcept>

namespace agentos {

static QString S(const char* s) { return QString::fromUtf8(s); }
static const QSet<QString> kKnown = {"Stack", "Grid", "Tabs", "Text", "Alert", "Metric", "Table", "Kanban", "Form", "TextInput", "TextArea",
                                     "Select", "Checkbox", "Button", "BarChart", "LineChart", "SystemActionButton", "List"};
static constexpr int kMaxNodes = 256, kMaxDepth = 12;

// ------------------------------------------------------------------ helpers
QString jsTrim(const QString& s) {
  auto ws = [](QChar c) {
    ushort u = c.unicode();
    return u == 0x09 || u == 0x0A || u == 0x0B || u == 0x0C || u == 0x0D || u == 0x20 || u == 0xA0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200A) ||
           u == 0x2028 || u == 0x2029 || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF;
  };
  int b = 0, e = int(s.size());
  while (b < e && ws(s[b])) b++;
  while (e > b && ws(s[e - 1])) e--;
  return s.mid(b, e - b);
}

double jsStringToNumber(const QString& raw) {
  const QString s = jsTrim(raw);
  if (s.isEmpty()) return 0;
  static const QRegularExpression inf(QStringLiteral("^[+-]?Infinity$"));
  static const QRegularExpression hex(QStringLiteral("^0[xX][0-9a-fA-F]+$"));
  static const QRegularExpression oct(QStringLiteral("^0[oO][0-7]+$"));
  static const QRegularExpression bin(QStringLiteral("^0[bB][01]+$"));
  static const QRegularExpression dec(QStringLiteral("^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$"));
  if (inf.match(s).hasMatch()) return s.startsWith(QLatin1Char('-')) ? -INFINITY : INFINITY;
  auto radix = [&](int base) {
    double v = 0;
    for (int i = 2; i < s.size(); ++i) v = v * base + QString(s[i]).toInt(nullptr, 16);
    return v;
  };
  if (hex.match(s).hasMatch()) return radix(16);
  if (oct.match(s).hasMatch()) return radix(8);
  if (bin.match(s).hasMatch()) return radix(2);
  if (dec.match(s).hasMatch()) return std::strtod(s.toLatin1().constData(), nullptr);
  return NAN;
}

QString jsNumberString(const JValue& v) { return asText(v); }

JValue encodeMissing(const JValue& v) {
  if (v.isMissing()) return JValue::object({{QStringLiteral("$missing"), JValue(true)}});
  if (v.isArray()) {
    JValue a = JValue::array();
    for (const auto& x : v.items()) a.push(encodeMissing(x));
    return a;
  }
  if (v.isObject()) {
    JValue o = JValue::object();
    for (const auto& m : v.members()) o.set(m.first, encodeMissing(m.second));
    return o;
  }
  return v;
}

JValue decodeMissing(const JValue& v) {
  if (v.isObject() && v.size() == 1 && v.get(QStringLiteral("$missing")).isBool()) return JValue();
  if (v.isArray()) {
    JValue a = JValue::array();
    for (const auto& x : v.items()) a.push(decodeMissing(x));
    return a;
  }
  if (v.isObject()) {
    JValue o = JValue::object();
    for (const auto& m : v.members()) o.set(m.first, decodeMissing(m.second));
    return o;
  }
  return v;
}

int countTemplateNodes(const JValue& nodes) {
  int n = 0;
  std::function<void(const JValue&)> walk = [&](const JValue& x) {
    n++;
    for (const auto& c : x.get(QStringLiteral("children")).items()) walk(c);
  };
  for (const auto& x : nodes.items()) walk(x);
  return n;
}

static bool isBind(const JValue& v) { return v.isObject() && v.has(QStringLiteral("$bind")); }
static JValue propsOf(const JValue& node) {
  const JValue& p = node.get(QStringLiteral("props"));
  return p.isNullish() ? JValue::object() : p;
}
static JValue childrenOf(const JValue& node) {
  const JValue& c = node.get(QStringLiteral("children"));
  return c.isArray() ? c : JValue::array();
}
static QString typeOf(const JValue& node) { return node.get(QStringLiteral("type")).stringOr(QString()); }
static JValue strOrNull(const JValue& v) { return v.isString() ? v : JValue::null(); }
static JValue orDefault(const JValue& v, const JValue& d) { return v.isNullish() ? d : v; }

// ------------------------------------------------------------------ requests
bool forwardRouteIsWrite(const QString& routeId, bool* known) {
  const JValue& r = routeTables().get(QStringLiteral("forward")).get(routeId);
  if (known) *known = !r.isMissing();
  return r.get(QStringLiteral("write")).toBool();
}

ForwardRequest makeForward(const QString& routeId, const JValue& params, const JValue& body, const QString& key) {
  bool known = false;
  ForwardRequest r;
  r.routeId = routeId;
  r.params = params;
  r.body = body;
  r.write = forwardRouteIsWrite(routeId, &known);
  if (!known) throw std::runtime_error(("route " + routeId + " is not registered").toStdString());
  r.idempotencyKey = key;
  return r;
}

JValue ForwardRequest::toJson() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("methodId"), methodId);
  o.set(QStringLiteral("routeId"), routeId);
  o.set(QStringLiteral("params"), params);
  o.set(QStringLiteral("body"), body.isMissing() ? JValue::null() : body);
  o.set(QStringLiteral("write"), write);
  o.set(QStringLiteral("idempotencyKey"), idempotencyKey);
  return o;
}

JValue ForwardRequest::forwardBody() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("routeId"), routeId);
  o.set(QStringLiteral("params"), params);
  o.set(QStringLiteral("body"), body.isMissing() ? JValue::null() : body);
  return o;
}

JValue Notice::toJson() const {
  if (!isSet()) return JValue::null();
  return JValue::object({{QStringLiteral("kind"), kind}, {QStringLiteral("text"), text}});
}

JValue ClickResult::toJson() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("kind"), kind);
  if (notice.isSet()) o.set(QStringLiteral("notice"), notice.toJson());
  if (kind == QLatin1String("confirm")) o.set(QStringLiteral("confirmText"), confirmText);
  if (request) o.set(QStringLiteral("request"), request->toJson());
  return o;
}

JValue RespondResult::toJson() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("notice"), notice.toJson());
  o.set(QStringLiteral("reload"), reload);
  o.set(QStringLiteral("openPlan"), openPlan.isEmpty() ? JValue::null() : JValue(openPlan));
  return o;
}

Outcome Outcome::fromJson(const JValue& v) {
  Outcome o;
  if (v.has(QStringLiteral("network"))) o.kind = Network;
  else if (v.has(QStringLiteral("apiError"))) {
    o.kind = ApiError;
    o.code = v.get(QStringLiteral("apiError")).str();
    o.message = v.get(QStringLiteral("message")).stringOr(o.code);
  } else if (v.has(QStringLiteral("plan"))) {
    o.kind = Plan;
    o.confirmationRequired = v.get(QStringLiteral("plan")).str() == QLatin1String("confirmationRequired");
    o.actionId = v.get(QStringLiteral("actionId")).str();
  } else {
    const QString inv = v.get(QStringLiteral("invocation")).str();
    if (inv == QLatin1String("succeeded")) {
      o.kind = InvocationSucceeded;
      o.commitCount = int(v.get(QStringLiteral("commitCount")).toNumber());
    } else if (inv == QLatin1String("failed")) {
      o.kind = InvocationFailed;
      o.code = v.get(QStringLiteral("code")).str();
      if (v.has(QStringLiteral("message"))) o.message = v.get(QStringLiteral("message")).str();
    } else {
      o.kind = InvocationRunning;
    }
  }
  return o;
}

// ------------------------------------------------------------------ runtime
SlotRuntime::SlotRuntime() {
  newKey_ = [] { return QUuid::createUuid().toString(QUuid::WithoutBraces); };
}

bool SlotRuntime::load(const JValue& bundle, const AppIdentity& app) {
  bundle_ = bundle;
  view_ = bundle.get(QStringLiteral("view"));
  app_ = app;
  issues_ = checkSlotTree(view_, contextForBundle(bundle));
  valid_ = issues_.isEmpty();
  return valid_;
}

QVector<ForwardRequest> SlotRuntime::queryRequests() const {
  QVector<ForwardRequest> out;
  for (const auto& m : view_.get(QStringLiteral("dataSources")).members()) {
    JValue params = JValue::object({{QStringLiteral("appId"), app_.appId}, {QStringLiteral("queryId"), m.second.get(QStringLiteral("queryId"))}});
    JValue body = JValue::object({{QStringLiteral("expectedAppEpoch"), app_.appEpoch}, {QStringLiteral("input"), orDefault(m.second.get(QStringLiteral("input")), JValue::object())}});
    out.push_back(makeForward(QStringLiteral("apps.queries.post"), params, body, QStringLiteral("q:") + m.first + QLatin1Char(':') + newKey_()));
  }
  return out;
}

bool SlotRuntime::applyQuery(const QString& source, const JValue& output, const QString& revisionId, double appEpoch) {
  if (revisionId != app_.revisionId || appEpoch != app_.appEpoch) return false;
  sources_[source] = output;
  return true;
}

JValue SlotRuntime::resolve(const JValue& v, const JValue& item, bool inItem) const {
  if (!isBind(v)) return v;
  const JValue& b = v.get(QStringLiteral("$bind"));
  const QString from = b.get(QStringLiteral("from")).stringOr(QString());
  if (from == QLatin1String("query")) {
    auto it = sources_.find(b.get(QStringLiteral("source")).str());
    return readPointer(it == sources_.end() ? JValue() : it.value(), b.get(QStringLiteral("pointer")).str());
  }
  if (from == QLatin1String("form")) {
    const JValue* f = forms_.find(b.get(QStringLiteral("formId")).str());
    return readPointer(f ? *f : JValue::object(), b.get(QStringLiteral("pointer")).str());
  }
  if (from == QLatin1String("selection")) {
    const JValue* s = selections_.find(b.get(QStringLiteral("selectionId")).str());
    return s ? *s : JValue::array();
  }
  if (from == QLatin1String("item")) return inItem ? readPointer(item, b.get(QStringLiteral("pointer")).str()) : JValue();
  return JValue();
}

bool SlotRuntime::visible(const JValue& node, const JValue& item, bool inItem) const {
  const JValue& w = node.get(QStringLiteral("visibleWhen"));
  if (w.isNullish()) return true;
  JValue v = resolve(w.get(QStringLiteral("value")), item, inItem);
  if (w.get(QStringLiteral("op")).str() == QLatin1String("exists")) return !v.isNullish();
  return v.strictEquals(w.get(QStringLiteral("equals")));
}

JValue SlotRuntime::render() const {
  JValue out = JValue::array();
  int counter = 0;
  const JValue& slotsV = view_.get(QStringLiteral("slots"));
  for (const QString slot : {QStringLiteral("toolbar"), QStringLiteral("main"), QStringLiteral("aside")}) {
    const JValue& n = slotsV.get(slot);
    if (n.isObject()) out.push(node(n, QStringLiteral("/view/slots/") + slot, QString(), 1, counter, JValue(), false));
  }
  return out;
}

static JValue hidden(const QString& path, const JValue& n) {
  return JValue::object({{QStringLiteral("path"), path}, {QStringLiteral("type"), n.get(QStringLiteral("type"))}, {QStringLiteral("visible"), false}});
}

JValue SlotRuntime::node(const JValue& n, const QString& path, const QString& formId, int depth, int& counter, const JValue& item, bool inItem) const {
  counter++;
  if (counter > kMaxNodes || depth > kMaxDepth)
    return JValue::object({{QStringLiteral("path"), path}, {QStringLiteral("type"), S("error")}, {QStringLiteral("text"), S("界面超过节点或层级上限")}});
  const QString type = typeOf(n);
  if (!kKnown.contains(type))
    return JValue::object({{QStringLiteral("path"), path}, {QStringLiteral("type"), S("error")}, {QStringLiteral("text"), S("未知组件 ") + asText(n.get(QStringLiteral("type")))}});
  if (!visible(n, item, inItem)) return hidden(path, n);
  const JValue p = propsOf(n);
  JValue base = JValue::object({{QStringLiteral("path"), path}, {QStringLiteral("type"), type}, {QStringLiteral("visible"), true}});
  auto kids = [&](const QString& fid) {
    JValue a = JValue::array();
    const JValue ch = childrenOf(n);
    for (int i = 0; i < ch.size(); ++i) a.push(node(ch.at(i), path + QStringLiteral("/children/") + QString::number(i), fid, depth + 1, counter, item, inItem));
    return a;
  };
  auto r = [&](const JValue& v) { return resolve(v, item, inItem); };
  auto merge = [&](const JValue& extra) {
    for (const auto& m : extra.members()) base.set(m.first, m.second);
    return base;
  };
  const JValue gap = orDefault(p.get(QStringLiteral("gap")), S("md"));
  if (type == QLatin1String("Stack")) {
    base.set(QStringLiteral("direction"), p.get(QStringLiteral("direction")).stringOr(QString()) == QLatin1String("horizontal") ? S("horizontal") : S("vertical"));
    base.set(QStringLiteral("gap"), gap);
    base.set(QStringLiteral("children"), kids(formId));
    return base;
  }
  if (type == QLatin1String("Grid")) {
    const JValue& c = p.get(QStringLiteral("columns"));
    double cols = c.isNumber() ? c.toNumber() : 0;
    base.set(QStringLiteral("columns"), (cols == 0 || std::isnan(cols)) ? 1.0 : cols);
    base.set(QStringLiteral("gap"), gap);
    base.set(QStringLiteral("children"), kids(formId));
    return base;
  }
  if (type == QLatin1String("Tabs")) {
    const int active = tabs_.value(path, 0);
    base.set(QStringLiteral("labels"), orDefault(p.get(QStringLiteral("labels")), JValue::array()));
    base.set(QStringLiteral("active"), active);
    JValue a = JValue::array();
    const JValue& child = childrenOf(n).at(active);
    if (child.isObject()) a.push(node(child, path + QStringLiteral("/children/") + QString::number(active), formId, depth + 1, counter, item, inItem));
    base.set(QStringLiteral("children"), a);
    return base;
  }
  if (type == QLatin1String("Text")) {
    base.set(QStringLiteral("text"), asText(r(p.get(QStringLiteral("text")))));
    base.set(QStringLiteral("variant"), orDefault(p.get(QStringLiteral("variant")), S("body")));
    return base;
  }
  if (type == QLatin1String("Alert")) {
    base.set(QStringLiteral("status"), p.get(QStringLiteral("status")));
    base.set(QStringLiteral("text"), asText(r(p.get(QStringLiteral("text")))));
    return base;
  }
  if (type == QLatin1String("Metric")) {
    base.set(QStringLiteral("label"), asText(p.get(QStringLiteral("label"))));
    base.set(QStringLiteral("value"), asText(r(p.get(QStringLiteral("value")))));
    base.set(QStringLiteral("unit"), strOrNull(p.get(QStringLiteral("unit"))));
    return base;
  }
  if (type == QLatin1String("Table")) return merge(table(p, path, item, inItem));
  if (type == QLatin1String("Kanban")) return merge(kanban(p, item, inItem));
  if (type == QLatin1String("Form")) {
    const QString fid = p.get(QStringLiteral("formId")).stringOr(QString());
    base.set(QStringLiteral("formId"), p.get(QStringLiteral("formId")));
    base.set(QStringLiteral("title"), strOrNull(p.get(QStringLiteral("title"))));
    base.set(QStringLiteral("children"), kids(fid));
    return base;
  }
  if (type == QLatin1String("TextInput") || type == QLatin1String("TextArea") || type == QLatin1String("Select") || type == QLatin1String("Checkbox")) {
    if (formId.isEmpty()) return hidden(path, n);
    const QString name = p.get(QStringLiteral("name")).str();
    const JValue v = formValues(formId).get(name);
    base.set(QStringLiteral("formId"), formId);
    base.set(QStringLiteral("name"), name);
    base.set(QStringLiteral("label"), asText(p.get(QStringLiteral("label"))));
    if (type == QLatin1String("Checkbox")) {
      base.set(QStringLiteral("checked"), v.isBool() && v.toBool());
      return base;
    }
    if (type == QLatin1String("Select")) {
      base.set(QStringLiteral("value"), v.isString() ? v.str() : QString());
      const JValue& req = p.get(QStringLiteral("required"));
      base.set(QStringLiteral("allowDefault"), !(req.isBool() && req.toBool()));
      JValue opts = JValue::array();
      for (const auto& o : p.get(QStringLiteral("options")).items())
        opts.push(JValue::object({{QStringLiteral("value"), o.get(QStringLiteral("value"))}, {QStringLiteral("label"), o.get(QStringLiteral("label"))}}));
      base.set(QStringLiteral("options"), opts);
      return base;
    }
    if (type == QLatin1String("TextArea")) {
      base.set(QStringLiteral("value"), v.isString() ? v.str() : QString());
      base.set(QStringLiteral("maxLength"), orDefault(p.get(QStringLiteral("maxLength")), 4096.0));
      return base;
    }
    const bool integer = p.get(QStringLiteral("mode")).stringOr(QString()) == QLatin1String("integer");
    base.set(QStringLiteral("value"), v.isNullish() ? QString() : asText(v));
    base.set(QStringLiteral("mode"), integer ? S("integer") : S("text"));
    base.set(QStringLiteral("maxLength"), integer ? JValue(16.0) : orDefault(p.get(QStringLiteral("maxLength")), 4096.0));
    base.set(QStringLiteral("placeholder"), asText(p.get(QStringLiteral("placeholder"))));
    return base;
  }
  if (type == QLatin1String("Button") || type == QLatin1String("SystemActionButton")) {
    base.set(QStringLiteral("label"), asText(p.get(QStringLiteral("label"))));
    if (type == QLatin1String("Button")) base.set(QStringLiteral("command"), p.get(QStringLiteral("command")));
    else base.set(QStringLiteral("action"), p.get(QStringLiteral("action")));
    base.set(QStringLiteral("variant"), orDefault(p.get(QStringLiteral("variant")), S("secondary")));
    base.set(QStringLiteral("disabled"), busy_ || disabled_ || staleInput_);
    if (type == QLatin1String("Button")) base.set(QStringLiteral("confirm"), strOrNull(p.get(QStringLiteral("confirm"))));
    return base;
  }
  if (type == QLatin1String("BarChart") || type == QLatin1String("LineChart")) return merge(chart(p, item, inItem));
  if (type == QLatin1String("List")) return merge(list(n, p, path, formId, depth, item, inItem));
  return hidden(path, n);
}

static QString rowIdOf(const JValue& it, const JValue& p, int i) {
  const JValue v = readPointer(it, orDefault(p.get(QStringLiteral("rowId")), S("/id")).str());
  return v.isString() ? v.str() : QString::number(i);
}

static bool selContains(const JValue& sels, const QString& sid, const QString& id) {
  for (const auto& x : sels.get(sid).items())
    if (x.str() == id) return true;
  return false;
}

JValue SlotRuntime::table(const JValue& p, const QString& path, const JValue& item, bool inItem) const {
  const JValue items = resolve(p.get(QStringLiteral("items")), item, inItem);
  const JValue list = items.isArray() ? items : JValue::array();
  const int size = p.get(QStringLiteral("pageSize")).isNumber() ? int(p.get(QStringLiteral("pageSize")).toNumber()) : 20;
  const int pages = std::max(1, int(std::ceil(double(list.size()) / size)));
  const int page = std::max(0, std::min(pages_.value(path, 0), pages - 1));
  const JValue& sel = p.get(QStringLiteral("selectionId"));
  JValue cols = JValue::array();
  for (const auto& c : p.get(QStringLiteral("columns")).items()) cols.push(c.get(QStringLiteral("label")));
  JValue rows = JValue::array();
  const int start = page * size, end = std::min(list.size(), start + size);
  for (int i = start; i < end; ++i) {
    const JValue& it = list.at(i);
    const QString id = rowIdOf(it, p, i);
    JValue cells = JValue::array();
    for (const auto& c : p.get(QStringLiteral("columns")).items()) cells.push(asText(readPointer(it, c.get(QStringLiteral("pointer")).str())));
    rows.push(JValue::object({{QStringLiteral("id"), id}, {QStringLiteral("selected"), sel.isString() && selContains(selections_, sel.str(), id)}, {QStringLiteral("cells"), cells}}));
  }
  JValue o = JValue::object();
  o.set(QStringLiteral("columns"), cols);
  o.set(QStringLiteral("selectionId"), strOrNull(sel));
  o.set(QStringLiteral("page"), page);
  o.set(QStringLiteral("pages"), pages);
  o.set(QStringLiteral("total"), list.size());
  QString empty = asText(p.get(QStringLiteral("emptyText")));
  o.set(QStringLiteral("emptyText"), rows.size() == 0 ? JValue(empty.isEmpty() ? S("没有数据") : empty) : JValue::null());
  o.set(QStringLiteral("rows"), rows);
  return o;
}

JValue SlotRuntime::kanban(const JValue& p, const JValue& item, bool inItem) const {
  const JValue items = resolve(p.get(QStringLiteral("items")), item, inItem);
  const int n = items.isArray() ? std::min(items.size(), 1000) : 0;
  const JValue& sel = p.get(QStringLiteral("selectionId"));
  const QString gp = p.get(QStringLiteral("groupPointer")).str();
  JValue columns = JValue::array();
  for (const auto& g : p.get(QStringLiteral("groups")).items()) {
    JValue cards = JValue::array();
    for (int i = 0; i < n; ++i) {
      const JValue& it = items.at(i);
      if (!readPointer(it, gp).strictEquals(g.get(QStringLiteral("value")))) continue;
      const QString id = rowIdOf(it, p, i);
      JValue fields = JValue::array();
      for (const auto& f : p.get(QStringLiteral("cardFields")).items())
        fields.push(f.get(QStringLiteral("label")).str() + S("：") + asText(readPointer(it, f.get(QStringLiteral("pointer")).str())));
      cards.push(JValue::object({{QStringLiteral("id"), id},
                                 {QStringLiteral("selected"), sel.isString() && selContains(selections_, sel.str(), id)},
                                 {QStringLiteral("title"), asText(readPointer(it, p.get(QStringLiteral("cardTitlePointer")).str()))},
                                 {QStringLiteral("fields"), fields}}));
    }
    columns.push(JValue::object({{QStringLiteral("label"), g.get(QStringLiteral("label"))}, {QStringLiteral("count"), cards.size()}, {QStringLiteral("cards"), cards}}));
  }
  JValue o = JValue::object();
  o.set(QStringLiteral("selectionId"), strOrNull(sel));
  o.set(QStringLiteral("columns"), columns);
  return o;
}

JValue SlotRuntime::chart(const JValue& p, const JValue& item, bool inItem) const {
  const JValue data = resolve(p.get(QStringLiteral("data")), item, inItem);
  const int rows = data.isArray() ? std::min(data.size(), 500) : 0;
  JValue xs = JValue::array();
  const QString xp = p.get(QStringLiteral("xPointer")).str();
  for (int i = 0; i < rows; ++i) xs.push(asText(readPointer(data.at(i), xp)));
  double max = 1;
  JValue series = JValue::array();
  const JValue& sp = p.get(QStringLiteral("series"));
  for (int s = 0; s < std::min(sp.size(), 8); ++s) {
    JValue vals = JValue::array();
    const QString ptr = sp.at(s).get(QStringLiteral("pointer")).str();
    for (int i = 0; i < rows; ++i) {
      const JValue v = readPointer(data.at(i), ptr);
      double d = v.isNumber() && std::isfinite(v.toNumber()) ? v.toNumber() : 0;
      vals.push(d);
      max = std::max(max, d);
    }
    series.push(JValue::object({{QStringLiteral("label"), sp.at(s).get(QStringLiteral("label"))}, {QStringLiteral("values"), vals}}));
  }
  JValue o = JValue::object();
  o.set(QStringLiteral("title"), strOrNull(p.get(QStringLiteral("title"))));
  o.set(QStringLiteral("xs"), xs);
  o.set(QStringLiteral("series"), series);
  o.set(QStringLiteral("max"), max);
  o.set(QStringLiteral("truncatedRows"), data.isArray() ? std::max(0, data.size() - 500) : 0);
  return o;
}

JValue SlotRuntime::list(const JValue& n, const JValue& p, const QString& path, const QString& formId, int depth, const JValue& item, bool inItem) const {
  const JValue data = resolve(p.get(QStringLiteral("items")), item, inItem);
  const JValue& mi = p.get(QStringLiteral("maxItems"));
  const int max = std::min(100, mi.isNumber() ? int(mi.toNumber()) : 50);
  const int count = data.isArray() ? std::min(max, data.size()) : 0;
  JValue o = JValue::object();
  o.set(QStringLiteral("direction"), p.get(QStringLiteral("direction")).stringOr(QString()) == QLatin1String("horizontal") ? S("horizontal") : S("vertical"));
  o.set(QStringLiteral("gap"), orDefault(p.get(QStringLiteral("gap")), S("md")));
  o.set(QStringLiteral("templateNodes"), countTemplateNodes(childrenOf(n)));
  if (count == 0) {
    QString e = asText(p.get(QStringLiteral("emptyText")));
    o.set(QStringLiteral("emptyText"), e.isEmpty() ? S("暂无数据") : e);
    o.set(QStringLiteral("items"), JValue::array());
    o.set(QStringLiteral("more"), JValue::null());
    return o;
  }
  QSet<QString> seen;
  JValue items = JValue::array();
  const JValue ch = childrenOf(n);
  for (int i = 0; i < count; ++i) {
    const JValue& it = data.at(i);
    QString key = asText(readPointer(it, orDefault(p.get(QStringLiteral("rowId")), S("/id")).str()));
    if (key.isEmpty() || seen.contains(key)) key = QStringLiteral("#") + QString::number(i);
    seen.insert(key);
    int counter = 0;
    JValue kids = JValue::array();
    for (int j = 0; j < ch.size(); ++j)
      kids.push(node(ch.at(j), path + QStringLiteral("/items/") + QString::number(i) + QStringLiteral("/children/") + QString::number(j), formId, depth + 1, counter, it, true));
    items.push(JValue::object({{QStringLiteral("key"), key}, {QStringLiteral("children"), kids}}));
  }
  o.set(QStringLiteral("emptyText"), JValue::null());
  o.set(QStringLiteral("items"), items);
  o.set(QStringLiteral("more"), data.size() > max ? JValue(QStringLiteral("仅显示前 %1 项（共 %2 项）").arg(max).arg(data.size())) : JValue::null());
  return o;
}

// ------------------------------------------------------------------ interaction
std::optional<SlotRuntime::Found> SlotRuntime::findNode(const QString& path) const {
  static const QRegularExpression re(QStringLiteral("^/view/slots/(main|toolbar|aside)(.*)$"));
  auto m = re.match(path);
  if (!m.hasMatch()) return std::nullopt;
  JValue node = view_.get(QStringLiteral("slots")).get(m.captured(1));
  Found f;
  const QStringList segs = m.captured(2).split(QLatin1Char('/'), Qt::SkipEmptyParts);
  bool okNum = false;
  for (int i = 0; node.isObject() && i < segs.size(); i += 2) {
    if (typeOf(node) == QLatin1String("Form")) f.formId = propsOf(node).get(QStringLiteral("formId")).str();
    const QString kind = segs[i];
    const int n = i + 1 < segs.size() ? segs[i + 1].toInt(&okNum) : -1;
    if (i + 1 >= segs.size() || !okNum) return std::nullopt;
    if (kind == QLatin1String("children")) node = childrenOf(node).at(n);
    else if (kind == QLatin1String("items") && typeOf(node) == QLatin1String("List")) {
      const JValue p = propsOf(node);
      const JValue data = resolve(p.get(QStringLiteral("items")), f.item, f.inItem);
      const JValue& mi = p.get(QStringLiteral("maxItems"));
      const int max = std::min(100, mi.isNumber() ? int(mi.toNumber()) : 50);
      if (!data.isArray() || n >= std::min(max, data.size())) return std::nullopt;
      f.item = data.at(n);
      f.inItem = true;
      i += 2;
      if (i + 1 >= segs.size() || segs[i] != QLatin1String("children")) return std::nullopt;
      node = childrenOf(node).at(segs[i + 1].toInt());
    } else {
      return std::nullopt;
    }
  }
  if (typeOf(node) == QLatin1String("Form")) f.formId = propsOf(node).get(QStringLiteral("formId")).str();
  if (!node.isObject()) return std::nullopt;
  f.node = node;
  return f;
}

JValue SlotRuntime::inputNode(const QString& formId, const QString& name) const {
  JValue found;
  std::function<void(const JValue&, const QString&)> walk = [&](const JValue& n, const QString& fid) {
    const JValue p = propsOf(n);
    const QString t = typeOf(n);
    const QString id = t == QLatin1String("Form") ? p.get(QStringLiteral("formId")).str() : fid;
    if (id == formId && p.get(QStringLiteral("name")).isString() && p.get(QStringLiteral("name")).str() == name &&
        (t == QLatin1String("TextInput") || t == QLatin1String("TextArea") || t == QLatin1String("Select") || t == QLatin1String("Checkbox")))
      found = n;
    for (const auto& c : n.get(QStringLiteral("children")).items()) walk(c, id);
  };
  for (const auto& m : view_.get(QStringLiteral("slots")).members())
    if (m.second.isObject()) walk(m.second, QString());
  return found;
}

const JValue& SlotRuntime::formValues(const QString& formId) const {
  static const JValue empty = JValue::object();
  const JValue* f = forms_.find(formId);
  return f ? *f : empty;
}

void SlotRuntime::setField(const QString& formId, const QString& name, const JValue& v) {
  JValue f = formValues(formId);
  f.set(name, v);
  forms_.set(formId, f);
}

void SlotRuntime::typeText(const QString& formId, const QString& name, const QString& raw) {
  const JValue n = inputNode(formId, name);
  if (n.isMissing()) throw std::runtime_error(("no input " + formId + "." + name).toStdString());
  const JValue p = propsOf(n);
  if (typeOf(n) == QLatin1String("TextInput") && p.get(QStringLiteral("mode")).stringOr(QString()) == QLatin1String("integer")) {
    if (jsTrim(raw).isEmpty()) return setField(formId, name, JValue());
    const JValue v(jsStringToNumber(raw));
    return setField(formId, name, v.isSafeInteger() ? v : JValue(raw));
  }
  setField(formId, name, raw);
}

void SlotRuntime::choose(const QString& formId, const QString& name, const QString& value) { setField(formId, name, value.isEmpty() ? JValue() : JValue(value)); }
void SlotRuntime::check(const QString& formId, const QString& name, bool on) { setField(formId, name, on); }

void SlotRuntime::toggle(const QString& sid, const QString& id, bool on) {
  JValue cur = selections_.get(sid);
  JValue next = JValue::array();
  bool present = false;
  for (const auto& x : cur.items()) {
    if (x.str() == id) {
      present = true;
      if (!on) continue;
    }
    next.push(x);
  }
  if (on && !present) next.push(id);
  selections_.set(sid, next);
}

QString SlotRuntime::validateForm(const QString& formId, const JValue& values) const {
  std::function<QString(const JValue&, bool)> walk = [&](const JValue& n, bool inForm) -> QString {
    const JValue p = propsOf(n);
    const QString t = typeOf(n);
    const bool here = t == QLatin1String("Form") ? (p.get(QStringLiteral("formId")).isString() && p.get(QStringLiteral("formId")).str() == formId) : inForm;
    if (here && (t == QLatin1String("TextInput") || t == QLatin1String("TextArea") || t == QLatin1String("Select"))) {
      const JValue v = values.get(p.get(QStringLiteral("name")).str());
      const QString label = asText(p.get(QStringLiteral("label")));
      const JValue& req = p.get(QStringLiteral("required"));
      const bool required = req.isBool() ? req.toBool() : !req.isNullish();
      if (required && (v.isMissing() || (v.isString() && v.str().isEmpty()))) return label + S("不能为空");
      if (t == QLatin1String("TextInput") && p.get(QStringLiteral("mode")).stringOr(QString()) == QLatin1String("integer") && !v.isMissing() && !v.isSafeInteger())
        return label + S("必须是整数");
      const JValue& mn = p.get(QStringLiteral("minimum"));
      const JValue& mx = p.get(QStringLiteral("maximum"));
      if (v.isNumber() && mn.isNumber() && v.toNumber() < mn.toNumber()) return label + S("不能小于 ") + asText(mn);
      if (v.isNumber() && mx.isNumber() && v.toNumber() > mx.toNumber()) return label + S("不能大于 ") + asText(mx);
      const JValue& ml = p.get(QStringLiteral("maxLength"));
      if (v.isString() && ml.isNumber() && codePointLength(v.str()) > ml.toNumber()) return label + S("不能超过 ") + asText(ml) + S(" 个字符");
    }
    for (const auto& c : n.get(QStringLiteral("children")).items()) {
      QString e = walk(c, here);
      if (!e.isEmpty()) return e;
    }
    return QString();
  };
  for (const auto& m : view_.get(QStringLiteral("slots")).members()) {
    if (!m.second.isObject()) continue;
    QString e = walk(m.second, false);
    if (!e.isEmpty()) return e;
  }
  return QString();
}

SlotRuntime::Assembled SlotRuntime::assemble(const JValue& p, const JValue& item, bool requireSelection) const {
  const JValue spec = orDefault(p.get(QStringLiteral("input")), JValue::object());
  Assembled a;
  a.input = JValue::object();
  for (const auto& m : spec.get(QStringLiteral("constant")).members()) a.input.set(m.first, m.second);
  if (spec.has(QStringLiteral("item"))) {
    const JValue& si = spec.get(QStringLiteral("item"));
    const JValue v = readPointer(item, si.get(QStringLiteral("pointer")).str());
    if (v.isMissing()) {
      a.error = S("该项缺少所需字段");
      return a;
    }
    a.input.set(si.get(QStringLiteral("as")).str(), v);
  }
  if (spec.has(QStringLiteral("form"))) {
    const QString form = spec.get(QStringLiteral("form")).str();
    const QString err = validateForm(form, formValues(form));
    if (!err.isEmpty()) {
      a.error = err;
      return a;
    }
    for (const auto& m : formValues(form).members())
      if (!m.second.isMissing() && !(m.second.isString() && m.second.str().isEmpty())) a.input.set(m.first, m.second);
  }
  if (spec.has(QStringLiteral("selection"))) {
    const JValue& ss = spec.get(QStringLiteral("selection"));
    JValue ids = selections_.get(ss.get(QStringLiteral("selectionId")).str());
    if (!ids.isArray()) ids = JValue::array();
    if (requireSelection && ids.size() == 0) {
      a.error = S("请先选择记录");
      return a;
    }
    a.input.set(ss.get(QStringLiteral("as")).str(), ids);
  }
  return a;
}

QString SlotRuntime::keyFor(const QString& sig) {
  QString key = (pendingKey_ && pendingKey_->first == sig) ? pendingKey_->second : newKey_();
  pendingKey_ = std::make_pair(sig, key);
  return key;
}

ClickResult SlotRuntime::click(const QString& path) {
  auto f = findNode(path);
  if (!f) throw std::runtime_error(("no node at " + path).toStdString());
  ClickResult res;
  if (busy_ || disabled_ || staleInput_) return res;
  const JValue p = propsOf(f->node);
  const QString t = typeOf(f->node);
  if (t == QLatin1String("Button")) {
    Assembled a = assemble(p, f->item, true);
    if (!a.error.isEmpty()) {
      notice_ = {S("error"), a.error};
      res.kind = S("error");
      res.notice = notice_;
      return res;
    }
    if (p.get(QStringLiteral("confirm")).isString()) {
      pendingConfirm_ = std::make_pair(p, f->item);
      res.kind = S("confirm");
      res.confirmText = p.get(QStringLiteral("confirm")).str();
      return res;
    }
    return sendCommand(p, a.input);
  }
  if (t == QLatin1String("SystemActionButton")) {
    Assembled a = assemble(p, f->item, false);
    if (!a.error.isEmpty()) {
      notice_ = {S("error"), a.error};
      res.kind = S("error");
      res.notice = notice_;
      return res;
    }
    const QString action = p.get(QStringLiteral("action")).str();
    JValue sig = JValue::object({{QStringLiteral("action"), action}, {QStringLiteral("input"), a.input}, {QStringLiteral("appEpoch"), app_.appEpoch}});
    const QString key = keyFor(sig.stringify());
    busy_ = true;
    inflight_ = Inflight{true, p, orDefault(p.get(QStringLiteral("input")), JValue::object())};
    notice_ = {S("info"), asText(p.get(QStringLiteral("label"))) + S("：正在生成计划（尚未执行）…")};
    res.kind = S("request");
    res.notice = notice_;
    res.request = makeForward(QStringLiteral("apps.systemactions.post"), JValue::object({{QStringLiteral("appId"), app_.appId}, {QStringLiteral("handlerId"), action}}),
                              JValue::object({{QStringLiteral("expectedAppEpoch"), app_.appEpoch}, {QStringLiteral("input"), a.input}}), key);
    return res;
  }
  throw std::runtime_error((t + " is not clickable").toStdString());
}

ClickResult SlotRuntime::confirm(bool accept) {
  auto c = pendingConfirm_;
  pendingConfirm_.reset();
  ClickResult res;
  if (!c || !accept) return res;
  Assembled a = assemble(c->first, c->second, true);
  if (!a.error.isEmpty()) {
    notice_ = {S("error"), a.error};
    res.kind = S("error");
    res.notice = notice_;
    return res;
  }
  return sendCommand(c->first, a.input);
}

ClickResult SlotRuntime::sendCommand(const JValue& p, const JValue& input) {
  const QString command = p.get(QStringLiteral("command")).str();
  JValue sig = JValue::object({{QStringLiteral("command"), command}, {QStringLiteral("input"), input}, {QStringLiteral("appEpoch"), app_.appEpoch}});
  const QString key = keyFor(sig.stringify());
  busy_ = true;
  inflight_ = Inflight{false, p, orDefault(p.get(QStringLiteral("input")), JValue::object())};
  notice_ = {S("info"), asText(p.get(QStringLiteral("label"))) + S("：已提交，执行中…")};
  ClickResult res;
  res.kind = S("request");
  res.notice = notice_;
  res.request = makeForward(QStringLiteral("apps.commands.post"), JValue::object({{QStringLiteral("appId"), app_.appId}, {QStringLiteral("commandId"), command}}),
                            JValue::object({{QStringLiteral("expectedAppEpoch"), app_.appEpoch}, {QStringLiteral("input"), input}}), key);
  return res;
}

RespondResult SlotRuntime::respond(const Outcome& o) {
  if (!inflight_) throw std::runtime_error("nothing in flight");
  Inflight f = *inflight_;
  inflight_.reset();
  busy_ = false;
  const QString label = asText(f.p.get(QStringLiteral("label")));
  RespondResult r;
  if (o.kind == Outcome::Network) {
    notice_ = {S("error"), networkErrorText()};
  } else if (o.kind == Outcome::ApiError) {
    if (!errorPolicy(o.code).keepKey) pendingKey_.reset();
    notice_ = {S("error"), describeError(o.code, o.message.isEmpty() ? o.code : o.message)};
  } else if (f.system && o.kind == Outcome::Plan) {
    pendingKey_.reset();
    notice_ = {S("info"), o.confirmationRequired ? label + S("：计划已生成，等待你在 AgentOS 确认框中确认（尚未执行）") : label + S("：已按持续授权提交，执行结果见操作中心")};
    r.openPlan = o.actionId;
  } else if (!f.system && (o.kind == Outcome::InvocationSucceeded || o.kind == Outcome::InvocationFailed || o.kind == Outcome::InvocationRunning)) {
    pendingKey_.reset();
    if (o.kind == Outcome::InvocationSucceeded) {
      notice_ = {S("ok"), label + S("：完成，") + QString::number(o.commitCount) + S(" 条记录已原子提交")};
      if (f.spec.has(QStringLiteral("form"))) forms_.set(f.spec.get(QStringLiteral("form")).str(), JValue::object());
      if (f.spec.has(QStringLiteral("selection"))) selections_.set(f.spec.get(QStringLiteral("selection")).get(QStringLiteral("selectionId")).str(), JValue::array());
      r.reload = true;
    } else if (o.kind == Outcome::InvocationFailed) {
      QString t = invocationText(o.code);
      if (t.isEmpty()) t = o.message.isEmpty() ? S("命令失败") : o.message;
      notice_ = {S("error"), t + S("（") + o.code + S("）")};
      if (o.code == QLatin1String("APP_EPOCH_STALE") || o.code == QLatin1String("DATA_EPOCH_STALE")) r.reload = true;
    } else {
      notice_ = {S("info"), S("命令仍在执行，稍后刷新查看结果")};
    }
  } else {
    throw std::runtime_error("outcome does not match the request");
  }
  r.notice = notice_;
  return r;
}

void SlotRuntime::switchRevision(const JValue& bundle, const AppIdentity& app) {
  if (app.revisionId == app_.revisionId) return;
  load(bundle, app);
  pendingKey_.reset();
  sources_.clear();
  selections_ = JValue::object();
  pages_.clear();
  tabs_.clear();
  bool dirty = false;
  for (const auto& f : forms_.members())
    for (const auto& v : f.second.members())
      if (!v.second.isMissing() && !(v.second.isString() && v.second.str().isEmpty())) dirty = true;
  if (dirty) staleInput_ = true;
}

void SlotRuntime::confirmNewVersion() {
  QMap<QString, QSet<QString>> names;
  std::function<void(const JValue&, const QString&)> walk = [&](const JValue& n, const QString& fid) {
    const JValue p = propsOf(n);
    const QString id = typeOf(n) == QLatin1String("Form") ? p.get(QStringLiteral("formId")).str() : fid;
    if (!id.isEmpty() && p.get(QStringLiteral("name")).isString()) names[id].insert(p.get(QStringLiteral("name")).str());
    for (const auto& c : n.get(QStringLiteral("children")).items()) walk(c, id);
  };
  for (const auto& m : view_.get(QStringLiteral("slots")).members())
    if (m.second.isObject()) walk(m.second, QString());
  JValue next = JValue::object();
  for (const auto& f : forms_.members()) {
    if (!names.contains(f.first)) continue;
    JValue vals = JValue::object();
    for (const auto& v : f.second.members())
      if (names[f.first].contains(v.first)) vals.set(v.first, v.second);
    next.set(f.first, vals);
  }
  forms_ = next;
  staleInput_ = false;
}

void SlotRuntime::clearScope() {
  sources_.clear();
  forms_ = JValue::object();
  selections_ = JValue::object();
  pages_.clear();
  tabs_.clear();
  pendingKey_.reset();
  notice_ = {};
  busy_ = false;
  inflight_.reset();
  pendingConfirm_.reset();
  staleInput_ = false;
}

void SlotRuntime::clearUnsubmittedInput() {
  forms_ = JValue::object();
  pendingConfirm_.reset();
  staleInput_ = false;
}

JValue SlotRuntime::formsSnapshot() const { return encodeMissing(forms_); }
JValue SlotRuntime::selectionsSnapshot() const { return selections_; }

}  // namespace agentos
