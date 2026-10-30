#pragma once
// Every request the Shell pages can produce (spec §11, §16.1): one native route or one registered forward route per
// action, never a free-form method/path. Port of packages/contracts/src/v1_0/slot-vectors-shell.ts.
#include "jvalue.hpp"

#include <QStringList>

namespace agentos {

struct ShellRequest {
  QString methodId;
  JValue params = JValue::object();
  JValue body = JValue::null();
  QString routeId;  // workspace.forward only
  bool write = false;
  JValue toJson() const;
  /** native-rpc/1 params/body: forward requests carry {routeId, params, body} as the native body. */
  JValue nativeParams() const;
  JValue nativeBody() const;
};

QStringList shellActionNames();
ShellRequest shellAction(const QString& name, const JValue& args);  // throws std::runtime_error
QStringList hardwareActions();
int displayRevertSeconds();
QString displayState(const JValue& r, const QStringList& extraFinal = {});

}  // namespace agentos
