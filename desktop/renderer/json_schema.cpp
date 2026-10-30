#include "json_schema.hpp"

#include <QRegularExpression>
#include <QHash>
#include <cmath>

namespace agentos {

const JValue& MiniSchema::resolveRef(const QString& ref) const {
  static const JValue none;
  if (!ref.startsWith(QLatin1String("#/$defs/"))) return none;
  return doc_.get(QStringLiteral("$defs")).get(ref.mid(8));
}

bool MiniSchema::validateDef(const QString& def, const JValue& value, QString* errorPath, QString* message) const {
  const JValue& s = doc_.get(QStringLiteral("$defs")).get(def);
  if (s.isMissing()) {
    if (message) *message = QStringLiteral("unknown schema");
    return false;
  }
  return validate(s, value, QString(), errorPath, message);
}

static bool typeMatches(const QString& t, const JValue& v) {
  if (t == QLatin1String("object")) return v.isObject();
  if (t == QLatin1String("array")) return v.isArray();
  if (t == QLatin1String("string")) return v.isString();
  if (t == QLatin1String("boolean")) return v.isBool();
  if (t == QLatin1String("null")) return v.isNull();
  if (t == QLatin1String("number")) return v.isNumber();
  if (t == QLatin1String("integer")) return v.isNumber() && std::isfinite(v.toNumber()) && std::floor(v.toNumber()) == v.toNumber();
  return false;
}

static const QRegularExpression& cachedRe(const QString& p) {
  static QHash<QString, QRegularExpression> cache;
  auto it = cache.find(p);
  if (it == cache.end()) it = cache.insert(p, QRegularExpression(p));
  return it.value();
}

bool MiniSchema::validate(const JValue& s, const JValue& v, const QString& path, QString* errorPath, QString* message) const {
  auto fail = [&](const QString& p, const QString& m) {
    if (errorPath) *errorPath = p;
    if (message) *message = m;
    return false;
  };
  if (!s.isObject()) return true;
  if (const JValue* ref = s.find(QStringLiteral("$ref"))) {
    if (!validate(resolveRef(ref->str()), v, path, errorPath, message)) return false;
  }
  if (const JValue* t = s.find(QStringLiteral("type"))) {
    bool ok = false;
    if (t->isString()) ok = typeMatches(t->str(), v);
    else
      for (const auto& x : t->items()) ok = ok || typeMatches(x.str(), v);
    if (!ok) return fail(path, QStringLiteral("must be ") + (t->isString() ? t->str() : t->stringify()));
  }
  if (const JValue* c = s.find(QStringLiteral("const"))) {
    if (!c->deepEquals(v)) return fail(path, QStringLiteral("must be equal to constant"));
  }
  if (const JValue* e = s.find(QStringLiteral("enum"))) {
    bool ok = false;
    for (const auto& x : e->items()) ok = ok || x.deepEquals(v);
    if (!ok) return fail(path, QStringLiteral("must be equal to one of the allowed values"));
  }
  if (v.isString()) {
    if (const JValue* m = s.find(QStringLiteral("maxLength")))
      if (codePointLength(v.str()) > m->toNumber()) return fail(path, QStringLiteral("must NOT have more characters"));
    if (const JValue* m = s.find(QStringLiteral("minLength")))
      if (codePointLength(v.str()) < m->toNumber()) return fail(path, QStringLiteral("must NOT have fewer characters"));
    if (const JValue* p = s.find(QStringLiteral("pattern")))
      if (!cachedRe(p->str()).match(v.str()).hasMatch()) return fail(path, QStringLiteral("must match pattern"));
  }
  if (v.isNumber()) {
    if (const JValue* m = s.find(QStringLiteral("minimum")))
      if (v.toNumber() < m->toNumber()) return fail(path, QStringLiteral("must be >= minimum"));
    if (const JValue* m = s.find(QStringLiteral("maximum")))
      if (v.toNumber() > m->toNumber()) return fail(path, QStringLiteral("must be <= maximum"));
  }
  if (v.isArray()) {
    if (const JValue* m = s.find(QStringLiteral("minItems")))
      if (v.size() < m->toNumber()) return fail(path, QStringLiteral("must NOT have fewer items"));
    if (const JValue* m = s.find(QStringLiteral("maxItems")))
      if (v.size() > m->toNumber()) return fail(path, QStringLiteral("must NOT have more items"));
    if (const JValue* it = s.find(QStringLiteral("items"))) {
      for (int i = 0; i < v.size(); ++i)
        if (!validate(*it, v.at(i), path + QLatin1Char('/') + QString::number(i), errorPath, message)) return false;
    }
  }
  if (v.isObject()) {
    if (const JValue* m = s.find(QStringLiteral("maxProperties")))
      if (v.size() > m->toNumber()) return fail(path, QStringLiteral("must NOT have more properties"));
    const JValue& props = s.get(QStringLiteral("properties"));
    if (const JValue* req = s.find(QStringLiteral("required"))) {
      for (const auto& r : req->items())
        if (!v.has(r.str())) return fail(path, QStringLiteral("must have required property '%1'").arg(r.str()));
    }
    const JValue* addl = s.find(QStringLiteral("additionalProperties"));
    if (addl && addl->isBool() && !addl->toBool()) {
      for (const auto& m : v.members())
        if (!props.has(m.first)) return fail(path, QStringLiteral("must NOT have additional properties"));
    }
    for (const auto& m : v.members()) {
      if (const JValue* ps = props.find(m.first))
        if (!validate(*ps, m.second, path + QLatin1Char('/') + m.first, errorPath, message)) return false;
    }
  }
  if (const JValue* any = s.find(QStringLiteral("anyOf"))) {
    bool ok = false;
    for (const auto& x : any->items())
      if (validate(x, v, path, nullptr, nullptr)) {
        ok = true;
        break;
      }
    if (!ok) return fail(path, QStringLiteral("must match a schema in anyOf"));
  }
  if (const JValue* one = s.find(QStringLiteral("oneOf"))) {
    int n = 0;
    for (const auto& x : one->items())
      if (validate(x, v, path, nullptr, nullptr)) n++;
    if (n != 1) return fail(path, QStringLiteral("must match exactly one schema in oneOf"));
  }
  return true;
}

}  // namespace agentos
