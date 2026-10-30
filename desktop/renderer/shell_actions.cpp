#include "shell_actions.hpp"

#include "error_policy.hpp"
#include "routes.hpp"
#include "slot_runtime.hpp"

#include <QMap>
#include <functional>
#include <stdexcept>

namespace agentos {

JValue ShellRequest::toJson() const {
  JValue o = JValue::object();
  o.set(QStringLiteral("methodId"), methodId);
  o.set(QStringLiteral("params"), params);
  o.set(QStringLiteral("body"), body);
  if (!routeId.isEmpty()) o.set(QStringLiteral("routeId"), routeId);
  o.set(QStringLiteral("write"), write);
  return o;
}
JValue ShellRequest::nativeParams() const { return routeId.isEmpty() ? params : JValue::object(); }
JValue ShellRequest::nativeBody() const {
  if (routeId.isEmpty()) return body;
  return JValue::object({{QStringLiteral("routeId"), routeId}, {QStringLiteral("params"), params}, {QStringLiteral("body"), body}});
}

using A = const JValue&;
using Fn = std::function<ShellRequest(A)>;

static QString s(const JValue& v) { return v.isMissing() ? QStringLiteral("undefined") : asText(v); }
static JValue O(std::initializer_list<JMember> m) { return JValue::object(JObject(m)); }
static ShellRequest fw(const QString& routeId, const JValue& params, const JValue& body) {
  ForwardRequest f = makeForward(routeId, params, body, QString());
  ShellRequest r;
  r.methodId = QStringLiteral("workspace.forward");
  r.routeId = routeId;
  r.params = f.params;
  r.body = body;
  r.write = true;
  return r;
}
static ShellRequest native(const QString& m, const JValue& params = JValue::object(), const JValue& body = JValue::null()) {
  if (!isNativeRoute(m)) throw std::runtime_error(("unknown native route " + m).toStdString());
  ShellRequest r;
  r.methodId = m;
  r.params = params;
  r.body = body;
  r.write = isWriteRoute(m);
  return r;
}
#define K(x) QStringLiteral(x)
#define G(x) a.get(QStringLiteral(x))

static const QMap<QString, Fn>& table() {
  static const QMap<QString, Fn> t = {
      {K("session.bind"), [](A) { return native(K("session.bind")); }},
      {K("session.status"), [](A) { return native(K("session.status")); }},
      {K("session.end"), [](A) { return native(K("session.end")); }},
      {K("workspaces.list"), [](A) { return native(K("workspaces.list")); }},
      {K("workspaces.get"), [](A a) { return native(K("workspaces.get"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("workspaces.create"), [](A a) { return native(K("workspaces.create"), JValue::object(), O({{K("displayName"), G("displayName")}})); }},
      {K("workspaces.start"), [](A a) { return native(K("workspaces.start"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("workspaces.stop"), [](A a) { return native(K("workspaces.stop"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("workspaces.archive"), [](A a) { return native(K("workspaces.archive"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("workspaces.attach"), [](A a) { return native(K("workspaces.attach"), O({{K("workspaceId"), G("workspaceId")}}), O({{K("expectedClientEpoch"), G("expectedClientEpoch")}})); }},
      {K("members.list"), [](A a) { return native(K("members.list"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("members.setRole"), [](A a) { return native(K("members.setRole"), O({{K("workspaceId"), G("workspaceId")}, {K("userId"), G("userId")}}), O({{K("role"), G("role")}, {K("expectedMemberVersion"), G("expectedMemberVersion")}})); }},
      {K("members.revoke"), [](A a) { return native(K("members.revoke"), O({{K("workspaceId"), G("workspaceId")}, {K("userId"), G("userId")}}), O({{K("expectedMemberVersion"), G("expectedMemberVersion")}})); }},
      {K("members.transferOwner"), [](A a) { return native(K("members.transferOwner"), O({{K("workspaceId"), G("workspaceId")}, {K("userId"), G("userId")}}), O({{K("expectedMemberVersion"), G("expectedMemberVersion")}, {K("confirm"), G("confirm")}})); }},
      {K("events.subscribe"), [](A a) { return native(K("events.subscribe"), O({{K("workspaceId"), G("workspaceId")}}), O({{K("cursor"), G("cursor")}})); }},
      {K("events.ack"), [](A a) { return native(K("events.ack"), O({{K("workspaceId"), G("workspaceId")}}), O({{K("cursor"), G("cursor")}})); }},
      {K("machine.status"), [](A) { return native(K("machine.status")); }},
      {K("machine.capabilities"), [](A) { return native(K("machine.capabilities")); }},
      {K("machine.plan"), [](A a) { return native(K("machine.actions.plan"), JValue::object(), O({{K("actionKind"), G("actionKind")}, {K("params"), G("params").isNullish() ? JValue::object() : G("params")}})); }},
      {K("machine.confirm"), [](A a) { return native(K("machine.actions.confirm"), O({{K("operationId"), G("operationId")}}), O({{K("planHash"), G("planHash")}, {K("ticket"), G("ticket")}})); }},
      {K("machine.get"), [](A a) { return native(K("machine.actions.get"), O({{K("operationId"), G("operationId")}})); }},
      {K("machine.cancel"), [](A a) { return native(K("machine.actions.cancel"), O({{K("operationId"), G("operationId")}})); }},
      {K("machine.users.create"), [](A a) { return native(K("machine.users.create"), JValue::object(), O({{K("userName"), G("userName")}, {K("displayName"), G("displayName")}})); }},
      {K("machine.users.disable"), [](A a) { return native(K("machine.users.disable"), O({{K("userId"), G("userId")}})); }},
      {K("updates.check"), [](A) { return native(K("updates.check")); }},
      {K("updates.prepare"), [](A a) { return native(K("updates.prepare"), JValue::object(), O({{K("releaseId"), G("releaseId")}, {K("manifestHash"), G("manifestHash")}})); }},
      {K("updates.activate"), [](A a) { return native(K("updates.activate"), JValue::object(), O({{K("releaseId"), G("releaseId")}})); }},
      {K("updates.status"), [](A) { return native(K("updates.status")); }},
      {K("updates.cancel"), [](A a) { return native(K("updates.cancel"), JValue::object(), O({{K("releaseId"), G("releaseId")}})); }},
      {K("backups.create"), [](A a) { return native(K("backups.create"), O({{K("workspaceId"), G("workspaceId")}}), O({{K("scope"), G("scope").isNullish() ? JValue(K("workspace")) : G("scope")}})); }},
      {K("backups.list"), [](A a) { return native(K("backups.list"), O({{K("workspaceId"), G("workspaceId")}})); }},
      {K("backups.export"), [](A a) { return native(K("backups.export"), O({{K("backupId"), G("backupId")}}), O({{K("targetId"), G("targetId")}})); }},
      {K("backups.inspect"), [](A a) { return native(K("backups.inspect"), O({{K("backupId"), G("backupId")}})); }},
      {K("restores.plan"), [](A a) { return native(K("restores.plan"), JValue::object(), O({{K("backupId"), G("backupId")}, {K("mode"), G("mode")}})); }},
      {K("restores.confirm"), [](A a) { return native(K("restores.confirm"), O({{K("restoreId"), G("restoreId")}}), O({{K("planHash"), G("planHash")}})); }},
      {K("restores.status"), [](A a) { return native(K("restores.status"), O({{K("restoreId"), G("restoreId")}})); }},
      {K("diagnostics.collect"), [](A a) { return native(K("diagnostics.collect"), JValue::object(), O({{K("scope"), G("scope")}, {K("redaction"), G("redaction").isNullish() ? JValue(K("default")) : G("redaction")}})); }},
      {K("apps.get"), [](A a) { return fw(K("apps.get"), O({{K("appId"), s(G("appId"))}}), JValue::null()); }},
      {K("apps.revisions"), [](A a) { return fw(K("apps.revisions.list"), O({{K("appId"), s(G("appId"))}}), JValue::null()); }},
      {K("apps.lifecycle"), [](A a) { return fw(K("apps.lifecycle.list"), O({{K("appId"), s(G("appId"))}}), JValue::null()); }},
      {K("app.archive"), [](A a) { return fw(K("apps.archive.post"), O({{K("appId"), s(G("appId"))}}), O({{K("expectedAppEpoch"), G("appEpoch")}})); }},
      {K("app.restore"), [](A a) { return fw(K("apps.restore.post"), O({{K("appId"), s(G("appId"))}}), JValue::object()); }},
      {K("app.deploy"), [](A a) { return fw(K("apps.deployments.post"), O({{K("appId"), s(G("appId"))}}), O({{K("revisionId"), G("revisionId")}, {K("expectedAppEpoch"), G("appEpoch")}})); }},
      {K("deployment.get"), [](A a) { return fw(K("deployments.get"), O({{K("deploymentId"), s(G("deploymentId"))}}), JValue::null()); }},
      {K("app.runtime"), [](A a) { return fw(K("apps.runtime.") + s(G("action")) + K(".post"), O({{K("appId"), s(G("appId"))}}), O({{K("expectedAppEpoch"), G("appEpoch")}})); }},
      {K("state"), [](A) { return fw(K("state.list"), JValue::object(), JValue::null()); }},
      {K("system"), [](A) { return fw(K("system.list"), JValue::object(), JValue::null()); }},
      {K("runs.list"), [](A) { return fw(K("runs.list"), JValue::object(), O({{K("limit"), 30}})); }},
      {K("runs.get"), [](A a) { return fw(K("runs.get"), O({{K("runId"), s(G("runId"))}}), JValue::null()); }},
      {K("runs.submit"), [](A a) {
         const JValue& t = G("targetAppId");
         const bool has = !(t.isNullish() || (t.isString() && t.str().isEmpty()) || (t.isBool() && !t.toBool()) || (t.isNumber() && t.toNumber() == 0));
         return fw(K("runs.post"), JValue::object(), has ? O({{K("intent"), G("intent")}, {K("targetAppId"), t}, {K("expectedAppEpoch"), G("expectedAppEpoch")}}) : O({{K("intent"), G("intent")}, {K("targetAppId"), JValue::null()}}));
       }},
      {K("runs.cancel"), [](A a) { return fw(K("runs.cancel.post"), O({{K("runId"), s(G("runId"))}}), JValue::object()); }},
      {K("runs.transcript"), [](A a) { return fw(K("runs.transcript.list"), O({{K("runId"), s(G("runId"))}}), JValue::null()); }},
      {K("conversation.compact"), [](A a) { return fw(K("conversations.compactions.post"), O({{K("id"), s(G("conversationId"))}}), JValue::object()); }},
      {K("compaction.cancel"), [](A a) { return fw(K("compactions.cancel.post"), O({{K("id"), s(G("compactionId"))}}), JValue::object()); }},
      {K("maintenance.state"), [](A) { return fw(K("maintenance.state.list"), JValue::object(), JValue::null()); }},
      {K("maintenance.policies"), [](A) { return fw(K("maintenance.policies.list"), JValue::object(), JValue::null()); }},
      {K("maintenance.jobs"), [](A) { return fw(K("maintenance.jobs.list"), JValue::object(), O({{K("limit"), 30}})); }},
      {K("maintenance.pause"), [](A) { return fw(K("maintenance.control.post"), JValue::object(), O({{K("action"), K("pause")}})); }},
      {K("maintenance.resume"), [](A) { return fw(K("maintenance.control.post"), JValue::object(), O({{K("action"), K("resume")}})); }},
      {K("maintenance.policy.approve"), [](A a) { return fw(K("maintenance.policies.approve.post"), O({{K("id"), s(G("policyId"))}}), O({{K("version"), G("version")}, {K("policyHash"), G("policyHash")}})); }},
      {K("maintenance.policy.pause"), [](A a) { return fw(K("maintenance.policies.pause.post"), O({{K("id"), s(G("policyId"))}}), JValue::object()); }},
      {K("maintenance.job.cancel"), [](A a) { return fw(K("maintenance.jobs.cancel.post"), O({{K("id"), s(G("jobId"))}}), JValue::object()); }},
      {K("maintenance.circuit.reset"), [](A a) { return fw(K("maintenance.circuits.reset.post"), JValue::object(), O({{K("targetKind"), G("targetKind")}, {K("targetId"), G("targetId")}})); }},
      {K("incidents"), [](A) { return fw(K("health.incidents.list"), JValue::object(), O({{K("open"), 1}})); }},
      {K("notifications"), [](A) { return fw(K("notifications.list"), JValue::object(), JValue::null()); }},
      {K("notification.read"), [](A a) { return fw(K("notifications.read.post"), O({{K("id"), s(G("id"))}}), JValue::object()); }},
      {K("proposals"), [](A) { return fw(K("proposals.list"), JValue::object(), JValue::null()); }},
      {K("proposal.accept"), [](A a) { return fw(K("proposals.accept.post"), O({{K("id"), s(G("proposalId"))}}), O({{K("proposalHash"), G("proposalHash")}, {K("expectedAppEpoch"), G("baseAppEpoch")}})); }},
      {K("proposal.reject"), [](A a) { return fw(K("proposals.reject.post"), O({{K("id"), s(G("proposalId"))}}), JValue::object()); }},
      {K("systemAction.get"), [](A a) { return fw(K("systemactions.get"), O({{K("actionId"), s(G("actionId"))}}), JValue::null()); }},
      {K("systemAction.confirm"), [](A a) { return fw(K("systemactions.confirm.post"), O({{K("actionId"), s(G("actionId"))}}), O({{K("planHash"), G("planHash")}})); }},
      {K("systemAction.cancel"), [](A a) { return fw(K("systemactions.cancel.post"), O({{K("actionId"), s(G("actionId"))}}), O({{K("reason"), QString::fromUtf8("用户取消")}})); }},
      {K("systemAction.resolve"), [](A a) { return fw(K("systemactions.resolve.post"), O({{K("actionId"), s(G("actionId"))}}), O({{K("decision"), G("decision")}, {K("note"), G("note")}, {K("releaseQuarantine"), !(G("decision").isString() && G("decision").str() == K("accept_unknown"))}})); }},
      {K("systemAction.compensate"), [](A a) { return fw(K("systemactions.compensations.post"), O({{K("actionId"), s(G("actionId"))}}), JValue::object()); }},
      {K("systemOperations"), [](A) { return fw(K("systemoperations.list"), JValue::object(), JValue::null()); }},
      {K("runtime.catalog"), [](A) { return fw(K("runtime.catalog.list"), JValue::object(), JValue::null()); }},
      {K("app.runtimeStatus"), [](A a) { return fw(K("apps.runtime.list"), O({{K("appId"), s(G("appId"))}}), JValue::null()); }},
  };
  return t;
}

QStringList shellActionNames() { return table().keys(); }

QStringList hardwareActions() {
  QStringList out;
  for (const auto& h : errorPolicyTable().get(QStringLiteral("hardwareActions")).items()) out << h.str();
  return out;
}
int displayRevertSeconds() { return int(errorPolicyTable().get(QStringLiteral("displayRevertSeconds")).toNumber()); }

ShellRequest shellAction(const QString& name, const JValue& args) {
  auto it = table().find(name);
  if (it == table().end()) throw std::runtime_error(("unknown shell action " + name).toStdString());
  ShellRequest r = it.value()(args.isObject() ? args : JValue::object());
  if (r.methodId == QLatin1String("machine.actions.plan")) {
    const JValue& k = r.body.get(QStringLiteral("actionKind"));
    const QString kind = k.isMissing() ? QStringLiteral("undefined") : asText(k);
    if (!hardwareActions().contains(kind) && !kind.startsWith(QLatin1String("machine."))) throw std::runtime_error(("unknown actionKind " + kind).toStdString());
  }
  return r;
}

QString displayState(const JValue& r, const QStringList& extraFinal) {
  JValue stv = r.get(QStringLiteral("state"));
  if (stv.isNullish()) stv = r.get(QStringLiteral("phase"));
  const QString st = stv.isNullish() ? QString() : asText(stv);
  QStringList finals;
  for (const auto& f : errorPolicyTable().get(QStringLiteral("finalStates")).items()) finals << f.str();
  // An authoritative final state wins over its explanatory error: a run cancelled by the user reports
  // status "cancelled" with error {code: CANCELLED}, and that is the reconciled outcome of runs.cancel.
  if (finals.contains(st) || extraFinal.contains(st)) return QStringLiteral("reconciled");
  const JValue& err = r.get(QStringLiteral("error"));
  if (err.isObject()) return err.get(QStringLiteral("code")).str() == QLatin1String("EFFECT_UNKNOWN") ? QStringLiteral("unknown") : QStringLiteral("failed");
  if (QStringList{"planned", "awaiting_confirmation", "needs_confirmation", "ready"}.contains(st)) return QStringLiteral("needs_confirmation");
  if (QStringList{"indeterminate", "unknown"}.contains(st)) return QStringLiteral("unknown");
  if (st == QLatin1String("failed")) return QStringLiteral("failed");
  if ((r.get(QStringLiteral("status")).isNumber() && r.get(QStringLiteral("status")).toNumber() == 202) || st == QLatin1String("accepted") || st == QLatin1String("queued"))
    return QStringLiteral("accepted");
  return QStringLiteral("in_progress");
}

}  // namespace agentos
