#pragma once
// Error texts and handling policy (spec §16.2), embedded from renderer/error-policy.json (generated from the TS model).
#include "jvalue.hpp"

namespace agentos {
struct ErrorPolicy {
  bool stopSubmits = false, rebind = false, lock = false, stopWrites = false, reread = false, keepInput = true, keepKey = false, hideObject = false;
  QString degrade;  // "", host, model, broker
  JValue toJson() const;
};
const JValue& errorPolicyTable();
ErrorPolicy errorPolicy(const QString& code);
QString describeError(const QString& code, const QString& message);
QString invocationText(const QString& code);  // empty when none
QString networkErrorText();
}  // namespace agentos
