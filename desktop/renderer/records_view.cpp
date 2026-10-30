#include "records_view.hpp"

#include <cmath>

namespace agentos::records {

static const JValue& fields(const JValue& b) { return b.get(QStringLiteral("data")).get(QStringLiteral("fields")); }
static const JValue& viewOf(const JValue& b) { return b.get(QStringLiteral("view")); }
static QString ftype(const JValue& f) { return f.get(QStringLiteral("type")).str(); }

JValue defaultDraft(const JValue& bundle) {
  JValue d = JValue::object();
  for (const auto& k : viewOf(bundle).get(QStringLiteral("formFields")).items()) {
    const JValue& f = fields(bundle).get(k.str());
    if (f.has(QStringLiteral("default"))) d.set(k.str(), f.get(QStringLiteral("default")));
    else if (ftype(f) == QLatin1String("boolean")) d.set(k.str(), false);
    else if (ftype(f) == QLatin1String("string")) d.set(k.str(), QString());
    else if (ftype(f) == QLatin1String("enum")) d.set(k.str(), f.get(QStringLiteral("values")).at(0));
  }
  return d;
}

QString displayValue(const JValue& f, const JValue& v) {
  if (v.isMissing()) return QString();
  if (ftype(f) == QLatin1String("boolean")) return v.toBool() ? QStringLiteral("✓") : QStringLiteral("—");
  return asText(v);
}

JValue fieldInput(const JValue& f, const JValue& raw) {
  if (ftype(f) == QLatin1String("boolean")) return JValue(raw.isBool() && raw.toBool());
  if (ftype(f) == QLatin1String("integer")) {
    if (raw.isString() && raw.str().isEmpty()) return JValue();
    return JValue(jsStringToNumber(raw.isString() ? raw.str() : asText(raw)));
  }
  return JValue(asText(raw));
}

ForwardRequest listRequest(const QString& appId, const JValue& bundle, const QString& q, const JValue& filters, int offset) {
  JValue body = JValue::object();
  if (viewOf(bundle).has(QStringLiteral("searchField")) && !q.isEmpty()) body.set(QStringLiteral("q"), q);
  if (filters.size() > 0) body.set(QStringLiteral("filters"), filters);
  body.set(QStringLiteral("offset"), offset);
  body.set(QStringLiteral("limit"), kPage);
  return makeForward(QStringLiteral("apps.records.list"), JValue::object({{QStringLiteral("appId"), appId}}), body, QStringLiteral("read"));
}

JValue changeFilter(const JValue& bundle, const JValue& filters, const QString& key, const QString& v) {
  const JValue& f = fields(bundle).get(key);
  JValue next = filters.isObject() ? filters : JValue::object();
  if (v.isEmpty()) next.remove(key);
  else next.set(key, ftype(f) == QLatin1String("boolean") ? JValue(v == QLatin1String("true")) : JValue(v));
  return next;
}

JValue keepFilters(const JValue& bundle, const JValue& filters) {
  JValue out = JValue::object();
  for (const auto& m : filters.members())
    for (const auto& k : viewOf(bundle).get(QStringLiteral("filters")).items())
      if (k.str() == m.first) out.set(m.first, m.second);
  return out;
}

JValue openEdit(const JValue& bundle, const JValue& data) {
  JValue d = JValue::object();
  for (const auto& k : viewOf(bundle).get(QStringLiteral("formFields")).items())
    if (!data.get(k.str()).isMissing()) d.set(k.str(), data.get(k.str()));
  return d;
}

static int cps(const QString& s) { return codePointLength(s); }

QString valueIssue(const JValue& f, const JValue& value) {
  const QString t = ftype(f);
  if (t == QLatin1String("string")) {
    if (!value.isString()) return QStringLiteral("must be a string");
    const int n = cps(value.str());
    const double minL = f.get(QStringLiteral("minLength")).isNumber() ? f.get(QStringLiteral("minLength")).toNumber() : 0;
    const double maxL = f.get(QStringLiteral("maxLength")).toNumber();
    if (n < minL) return minL == 1 ? QStringLiteral("must not be empty") : QStringLiteral("must have at least %1 characters").arg(asText(JValue(minL)));
    if (n > maxL) return QStringLiteral("must have at most %1 characters").arg(asText(JValue(maxL)));
    return {};
  }
  if (t == QLatin1String("boolean")) return value.isBool() ? QString() : QStringLiteral("must be a boolean");
  if (t == QLatin1String("integer")) {
    if (!value.isSafeInteger()) return QStringLiteral("must be a safe integer");
    const double mn = f.get(QStringLiteral("minimum")).isNumber() ? f.get(QStringLiteral("minimum")).toNumber() : -9007199254740991.0;
    const double mx = f.get(QStringLiteral("maximum")).isNumber() ? f.get(QStringLiteral("maximum")).toNumber() : 9007199254740991.0;
    if (value.toNumber() < mn) return QStringLiteral("must be >= %1").arg(asText(JValue(mn)));
    if (value.toNumber() > mx) return QStringLiteral("must be <= %1").arg(asText(JValue(mx)));
    return {};
  }
  if (t == QLatin1String("enum")) {
    if (!value.isString()) return QStringLiteral("must be a string");
    QStringList vals;
    for (const auto& v : f.get(QStringLiteral("values")).items()) {
      if (v.str() == value.str()) return {};
      vals << v.str();
    }
    return QStringLiteral("must be one of %1").arg(vals.join(QStringLiteral(", ")));
  }
  return {};
}

JValue localIssues(const JValue& bundle, const JValue& draft) {
  JValue out = JValue::object();
  for (const auto& k : viewOf(bundle).get(QStringLiteral("formFields")).items()) {
    const JValue& v = draft.get(k.str());
    if (v.isMissing()) continue;
    const QString m = valueIssue(fields(bundle).get(k.str()), v);
    if (!m.isEmpty()) out.set(k.str(), m);
  }
  return out;
}

ForwardRequest createRequest(const QString& appId, double appEpoch, const JValue& draft, const QString& key) {
  JValue data = JValue::object();
  for (const auto& m : draft.members())
    if (!m.second.isMissing()) data.set(m.first, m.second);
  return makeForward(QStringLiteral("apps.records.post"), JValue::object({{QStringLiteral("appId"), appId}}),
                     JValue::object({{QStringLiteral("expectedAppEpoch"), appEpoch}, {QStringLiteral("data"), data}}), key);
}

std::optional<ForwardRequest> editRequest(const QString& appId, double appEpoch, const JValue& record, const JValue& draft, const QString& key) {
  JValue changes = JValue::object();
  const JValue& data = record.get(QStringLiteral("data"));
  for (const auto& m : draft.members())
    if (!m.second.isMissing() && !m.second.strictEquals(data.get(m.first))) changes.set(m.first, m.second);
  if (changes.size() == 0) return std::nullopt;
  return makeForward(QStringLiteral("apps.records.patch"), JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("recordId"), record.get(QStringLiteral("id"))}}),
                     JValue::object({{QStringLiteral("expectedAppEpoch"), appEpoch}, {QStringLiteral("expectedRecordVersion"), record.get(QStringLiteral("recordVersion"))}, {QStringLiteral("changes"), changes}}), key);
}

ForwardRequest deleteRequest(const QString& appId, double appEpoch, const JValue& record, const QString& key) {
  return makeForward(QStringLiteral("apps.records.delete"), JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("recordId"), record.get(QStringLiteral("id"))}}),
                     JValue::object({{QStringLiteral("expectedAppEpoch"), appEpoch}, {QStringLiteral("expectedRecordVersion"), record.get(QStringLiteral("recordVersion"))}}), key);
}

JValue rebase(const JValue& bundle, const QString& mode, const JValue& draft) {
  JValue fresh = mode == QLatin1String("create") ? defaultDraft(bundle) : JValue::object();
  for (const auto& k : viewOf(bundle).get(QStringLiteral("formFields")).items())
    if (!draft.get(k.str()).isMissing()) fresh.set(k.str(), draft.get(k.str()));
  return fresh;
}

ForwardRequest deployRequest(const QString& appId, double appEpoch, const QString& revisionId, const QString& key) {
  return makeForward(QStringLiteral("apps.deployments.post"), JValue::object({{QStringLiteral("appId"), appId}}),
                     JValue::object({{QStringLiteral("revisionId"), revisionId}, {QStringLiteral("expectedAppEpoch"), appEpoch}}), key);
}

QString keyAfter(const QString& outcome) { return outcome == QLatin1String("network") ? QStringLiteral("keep") : QStringLiteral("fresh"); }

}  // namespace agentos::records
