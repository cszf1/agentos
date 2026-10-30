#include "error_policy.hpp"

#include <QFile>

namespace agentos {

const JValue& errorPolicyTable() {
  static const JValue t = [] {
    QFile f(QStringLiteral(":/agentos/renderer/error-policy.json"));
    if (!f.open(QIODevice::ReadOnly)) qFatal("error-policy.json missing from resources");
    return parseJsonOrThrow(f.readAll());
  }();
  return t;
}

ErrorPolicy errorPolicy(const QString& code) {
  JValue p = errorPolicyTable().get(QStringLiteral("policy")).get(code);
  if (p.isMissing()) p = errorPolicyTable().get(QStringLiteral("defaultPolicy"));
  ErrorPolicy e;
  e.stopSubmits = p.get(QStringLiteral("stopSubmits")).toBool();
  e.rebind = p.get(QStringLiteral("rebind")).toBool();
  e.lock = p.get(QStringLiteral("lock")).toBool();
  e.stopWrites = p.get(QStringLiteral("stopWrites")).toBool();
  e.reread = p.get(QStringLiteral("reread")).toBool();
  e.keepInput = p.get(QStringLiteral("keepInput")).toBool();
  e.keepKey = p.get(QStringLiteral("keepKey")).toBool();
  e.hideObject = p.get(QStringLiteral("hideObject")).toBool();
  const JValue& d = p.get(QStringLiteral("degrade"));
  e.degrade = d.isString() ? d.str() : QString();
  return e;
}

JValue ErrorPolicy::toJson() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("stopSubmits"), stopSubmits);
  o.set(QStringLiteral("rebind"), rebind);
  o.set(QStringLiteral("lock"), lock);
  o.set(QStringLiteral("stopWrites"), stopWrites);
  o.set(QStringLiteral("reread"), reread);
  o.set(QStringLiteral("keepInput"), keepInput);
  o.set(QStringLiteral("keepKey"), keepKey);
  o.set(QStringLiteral("degrade"), degrade.isEmpty() ? JValue::null() : JValue(degrade));
  o.set(QStringLiteral("hideObject"), hideObject);
  return o;
}

QString describeError(const QString& code, const QString& message) {
  const JValue& t = errorPolicyTable().get(QStringLiteral("errorText")).get(code);
  if (t.isString() && !t.str().isEmpty()) return t.str() + QStringLiteral("（") + code + QStringLiteral("）");
  return message + QStringLiteral("（") + code + QStringLiteral("）");
}

QString invocationText(const QString& code) {
  const JValue& t = errorPolicyTable().get(QStringLiteral("invocationText")).get(code);
  return t.isString() ? t.str() : QString();
}

QString networkErrorText() { return errorPolicyTable().get(QStringLiteral("networkText")).str(); }

}  // namespace agentos
