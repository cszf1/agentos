#include "shell_controller.hpp"

#include "error_policy.hpp"

#include <QClipboard>
#include <QGuiApplication>
#include <QStandardPaths>
#include <QUuid>

namespace agentos {

const QString ShellController::kMachineScope = QStringLiteral("00000000-0000-0000-0000-000000000000");
static QString S(const char* s) { return QString::fromUtf8(s); }
static QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }

// ------------------------------------------------------------------ ActionTracker
QString ActionTracker::add(const QString& name, const QString& label, const ShellRequest& req, const QString& key) {
  const QString id = uuid();
  JValue r = JValue::object({{QStringLiteral("id"), id},
                             {QStringLiteral("name"), name},
                             {QStringLiteral("label"), label.isEmpty() ? name : label},
                             {QStringLiteral("state"), QStringLiteral("accepted")},
                             {QStringLiteral("stateText"), S("已提交，等待受理")},
                             {QStringLiteral("detail"), QString()},
                             {QStringLiteral("route"), req.routeId.isEmpty() ? req.methodId : req.routeId},
                             {QStringLiteral("hasKey"), !key.isEmpty()}});
  rows_.insert(rows_.begin(), r);
  if (rows_.size() > 50) rows_.pop_back();
  publish();
  return id;
}

static QString stateText(const QString& s) {
  if (s == QLatin1String("accepted")) return S("已受理");
  if (s == QLatin1String("in_progress")) return S("进行中");
  if (s == QLatin1String("needs_confirmation")) return S("需要确认");
  if (s == QLatin1String("reconciled")) return S("已核对结果");
  if (s == QLatin1String("failed")) return S("失败");
  if (s == QLatin1String("unknown")) return S("结果未知（按请求 ID 查询中，不会自动重做）");
  if (s == QLatin1String("refused")) return S("未提交");
  return s;
}

void ActionTracker::setState(const QString& id, const QString& state, const QString& detail, const JValue& extra) {
  for (auto& r : rows_)
    if (r.get(QStringLiteral("id")).str() == id) {
      r.set(QStringLiteral("state"), state);
      r.set(QStringLiteral("stateText"), stateText(state));
      if (!detail.isNull()) r.set(QStringLiteral("detail"), detail);
      for (const auto& m : extra.members()) r.set(m.first, m.second);
    }
  publish();
}

JValue ActionTracker::row(const QString& id) const {
  for (const auto& r : rows_)
    if (r.get(QStringLiteral("id")).str() == id) return r;
  return JValue();
}

void ActionTracker::clearAll() {
  rows_.clear();
  publish();
}

void ActionTracker::publish() { setItems(JValue::array(rows_)); }

// ------------------------------------------------------------------ controller
ShellController::ShellController(QString socketPath, QObject* parent)
    : QObject(parent),
      rpc_(new RpcClient(std::move(socketPath), this)),
      workspaces_(new JsonListModel(QStringLiteral("workspaceId"), this)),
      members_(new JsonListModel(QStringLiteral("userId"), this)),
      apps_(new JsonListModel(QStringLiteral("appId"), this)),
      runs_(new JsonListModel(QStringLiteral("runId"), this)),
      policies_(new JsonListModel(QStringLiteral("policyId"), this)),
      jobs_(new JsonListModel(QStringLiteral("jobId"), this)),
      incidents_(new JsonListModel(QStringLiteral("incidentId"), this)),
      proposals_(new JsonListModel(QStringLiteral("proposalId"), this)),
      notifications_(new JsonListModel(QStringLiteral("id"), this)),
      backups_(new JsonListModel(QStringLiteral("backupId"), this)),
      revisions_(new JsonListModel(QStringLiteral("revisionId"), this)),
      operations_(new JsonListModel(QStringLiteral("actionId"), this)),
      actions_(new ActionTracker(QStringLiteral("id"), this)),
      canvas_(new CanvasModel(this)) {
  layoutDir_ = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
  canvas_->setViewProvider([this](const QString& id) { return appView(id); });
  connect(canvas_, &CanvasModel::limitReached, this, [this] { setNotice(S("最多同时展开 4 张卡，其它只显示摘要")); });
  connect(rpc_, &RpcClient::connectionChanged, this, &ShellController::onConnection);
  connect(rpc_, &RpcClient::eventReceived, this, &ShellController::onEvent);
  connect(rpc_, &RpcClient::gap, this, [this](const QString& ws, const QString&) { onGap(ws); });
  connect(rpc_, &RpcClient::statsChanged, this, &ShellController::transportChanged);
  connect(rpc_, &RpcClient::pendingUnknown, this, [this](const QString&) { setNotice(S("一个请求 30 秒没有回应：结果未知，正在按请求 ID 查询（不会重复提交）")); });
  statusPoll_.setInterval(5000);
  connect(&statusPoll_, &QTimer::timeout, this, &ShellController::pollStatus);
  displayRevert_.setInterval(1000);
  connect(&displayRevert_, &QTimer::timeout, this, [this] {
    if (--displayRevertLeft_ <= 0) {
      displayRevert_.stop();
      displayRevertLeft_ = 0;
      // 15 s without "keep": restore the previous display configuration (spec §12.1).
      if (displayPrevious_.isObject()) hardware(QStringLiteral("display.revert"), displayPrevious_.toVariant().toMap());
      displayPrevious_ = JValue();
    }
    emit displayRevertChanged();
  });
}

ShellController::~ShellController() = default;

void ShellController::start() {
  rpc_->start();
  statusPoll_.start();
}

QVariantMap ShellController::transportStats() const {
  const RpcStats s = rpc_->stats();
  return {{QStringLiteral("inflight"), s.inflight}, {QStringLiteral("queued"), s.queued},       {QStringLiteral("reconnects"), s.reconnects},
          {QStringLiteral("resent"), s.resent},     {QStringLiteral("statusQueries"), s.statusQueries}, {QStringLiteral("gaps"), s.gaps},
          {QStringLiteral("protocolErrors"), s.protocolErrors}, {QStringLiteral("lateDropped"), lateDropped_}};
}

QString ShellController::banner() const {
  if (!connected_) return S("与系统网关断开，正在重连…（显示的是缓存内容）");
  if (locked_) return S("会话已锁定");
  if (!hostAvailable_) return S("工作区服务不可用：只读缓存，更新于 ") + cachedAt() + S("，不能提交");
  if (writesStopped_) return S("你的成员权限正在撤销或已撤销：写入已停止");
  if (!brokerAvailable_) return S("系统执行服务不可用：系统动作已暂停，普通数据操作仍可使用");
  if (!modelAvailable_) return S("模型不可用：已激活的应用照常运行，暂不能生成或修改应用");
  return QString();
}

void ShellController::setNotice(const QString& t) {
  if (t == notice_) return;
  notice_ = t;
  emit noticeChanged();
}

void ShellController::setCurrentPage(const QString& p) {
  if (p == page_) return;
  page_ = p;
  emit pageChanged();
  refreshPage();
}

void ShellController::setIntentDraft(const QString& t) {
  if (t == intentDraft_) return;
  intentDraft_ = t.left(4000);
  emit draftsChanged();
}

void ShellController::setUiScale(qreal s) {
  s = std::clamp(s, 0.75, 2.0);
  if (qFuzzyCompare(s, uiScale_)) return;
  uiScale_ = s;
  emit uiScaleChanged();
}
void ShellController::zoom(int step) { setUiScale(step == 0 ? 1.0 : uiScale_ + 0.125 * step); }

// ------------------------------------------------------------------ requests
void ShellController::sendNative(const ShellRequest& r, const QString& key, std::function<void(const RpcReply&)> done, bool scoped) {
  RpcCall c;
  c.workspaceId = ws_.isEmpty() ? kMachineScope : ws_;
  if (!scoped && r.routeId.isEmpty() && !r.params.has(QStringLiteral("workspaceId"))) c.workspaceId = ws_.isEmpty() ? kMachineScope : ws_;
  c.clientEpoch = clientEpoch_;
  c.sessionEpoch = sessionEpoch_;
  c.methodId = r.methodId;
  c.params = r.nativeParams();
  c.body = r.nativeBody();
  c.idempotencyKey = r.write ? (key.isEmpty() ? uuid() : key) : QString();
  const Scope s = scope();
  rpc_->call(c, [this, s, scoped, done = std::move(done)](const RpcReply& rep) {
    if (scoped && !inScope(s)) {
      lateDropped_++;  // a reply for a workspace/epoch/store we have left: never applied
      emit transportChanged();
      return;
    }
    if (rep.ok() && !rep.local) {
      cachedAt_ = QDateTime::currentDateTime();
    }
    if (done) done(rep);
  });
}

void ShellController::request(const QString& name, const JValue& args, std::function<void(const RpcReply&)> done, bool scoped) {
  ShellRequest r;
  try {
    r = shellAction(name, args);
  } catch (const std::exception& e) {
    setNotice(QString::fromUtf8(e.what()));
    return;
  }
  sendNative(r, QString(), [this, done](const RpcReply& rep) {
    if (rep.ok() && !hostAvailable_) markHostDown(false);
    if (!rep.ok()) reportError(rep.errorCode);
    if (done) done(rep);
  }, scoped);
}

void ShellController::sendForward(const ForwardRequest& f, std::function<void(const RpcReply&)> done) {
  ShellRequest r;
  r.methodId = QStringLiteral("workspace.forward");
  r.routeId = f.routeId;
  r.params = f.params;
  r.body = f.body;
  r.write = true;
  sendNative(r, f.idempotencyKey.startsWith(QLatin1String("q:")) || f.idempotencyKey == QLatin1String("read") ? QStringLiteral("read:") + uuid() : f.idempotencyKey,
             [this, done](const RpcReply& rep) {
               if (rep.ok() && !hostAvailable_) markHostDown(false);
               if (done) done(rep);
             });
}

bool ShellController::canWrite(bool systemAction) const {
  if (readOnly() || writesStopped_) return false;
  if (systemAction && !brokerAvailable_) return false;
  return true;
}

void ShellController::reportError(const QString& code) {
  if (code.isEmpty()) return;
  const ErrorPolicy p = errorPolicy(code);
  if (p.degrade == QLatin1String("host")) markHostDown(true);
  if (p.degrade == QLatin1String("model") && modelAvailable_) {
    modelAvailable_ = false;
    emit statusChanged();
  }
  if (p.degrade == QLatin1String("broker") && brokerAvailable_) {
    brokerAvailable_ = false;
    emit statusChanged();
  }
  if (p.lock) onLocked();
  if (p.rebind) rebind();
  if (p.stopWrites && (code == QLatin1String("MEMBERSHIP_REVOKED") || code == QLatin1String("REGISTRY_NOT_SYNCED"))) {
    writesStopped_ = true;
    for (auto* v : views_) v->setDisabled(true);
    emit statusChanged();
  }
  if (code == QLatin1String("CLIENT_EPOCH_STALE") && !ws_.isEmpty()) attach(ws_, true);
  if (code == QLatin1String("EVENT_GAP") && !ws_.isEmpty()) onGap(ws_);
}

void ShellController::markHostDown(bool down) {
  if (hostAvailable_ == !down) return;
  hostAvailable_ = !down;
  for (auto* v : views_) v->setDisabled(readOnly() || writesStopped_);
  emit statusChanged();
}

// ------------------------------------------------------------------ session
void ShellController::onConnection(bool up) {
  connected_ = up;
  for (auto* v : views_) v->setDisabled(readOnly() || writesStopped_);
  emit statusChanged();
  if (up) bind();
}

void ShellController::reconnect() { rpc_->reconnectNow(); }
void ShellController::rebind() { bind(); }

void ShellController::bind() {
  request(QStringLiteral("session.bind"), JValue::object(), [this](const RpcReply& r) {
    if (!r.ok()) {
      sessionBound_ = false;
      setNotice(describeError(r.errorCode, r.errorMessage));
      emit statusChanged();
      return;
    }
    sessionBound_ = true;
    userId_ = r.body.get(QStringLiteral("userId")).stringOr(QString());
    userName_ = r.body.get(QStringLiteral("userName")).stringOr(userId_);
    role_ = r.body.get(QStringLiteral("role")).stringOr(QString());
    const qint64 e = qint64(r.body.get(QStringLiteral("sessionEpoch")).toNumber());
    if (e > 0) sessionEpoch_ = e;
    locked_ = r.body.get(QStringLiteral("locked")).toBool();
    emit statusChanged();
    loadMachine();
    loadWorkspaces();
  }, false);
}

void ShellController::pollStatus() {
  if (!connected_ || !sessionBound_) return;
  request(QStringLiteral("session.status"), JValue::object(), [this](const RpcReply& r) {
    if (r.ok()) applySessionStatus(r.body);
  }, false);
  static int n = 0;
  if (++n % 3 == 0) loadMachine();
}

void ShellController::applySessionStatus(const JValue& s) {
  const qint64 e = qint64(s.get(QStringLiteral("sessionEpoch")).toNumber());
  const bool nowLocked = s.get(QStringLiteral("locked")).toBool();
  if ((e > 0 && e != sessionEpoch_) || (nowLocked && !locked_)) {
    // sessionEpoch moved (lock confirmed by the session agent): drop sensitive UI state first.
    onLocked();
    if (e > 0) sessionEpoch_ = e;
  }
  if (!nowLocked && locked_) {
    locked_ = false;
    emit statusChanged();
    bind();  // unlock re-binds session and workspace state
    return;
  }
  locked_ = nowLocked;
  emit statusChanged();
}

void ShellController::onLocked() {
  locked_ = true;
  // Lock clears notification text, task prompts, the clipboard and every unsubmitted (sensitive) input.
  notifications_->clear();
  intentDraft_.clear();
  intentKey_.clear();
  transcriptText_.clear();
  diagnosticsText_.clear();
  setNotice(QString());
  if (auto* cb = QGuiApplication::clipboard()) {
    cb->clear(QClipboard::Clipboard);
    if (cb->supportsSelection()) cb->clear(QClipboard::Selection);
  }
  for (auto* v : views_) {
    v->runtime().clearUnsubmittedInput();
    v->clearScope();
  }
  if (confirm_.value(QStringLiteral("visible")).toBool()) {
    auto done = confirmDone_;
    confirmDone_ = {};
    confirm_.clear();
    emit confirmChanged();
    if (done) done(false);  // a pending confirmation is never carried over a lock
  }
  emit draftsChanged();
  emit pagesChanged();
  emit statusChanged();
  emit scopeCleared(QStringLiteral("lock"));
}

// ------------------------------------------------------------------ workspace scope
void ShellController::loadWorkspaces() {
  request(QStringLiteral("workspaces.list"), JValue::object(), [this](const RpcReply& r) {
    if (!r.ok()) return;
    workspaces_->setItems(r.body.get(QStringLiteral("items")));
    bool stillMember = ws_.isEmpty();
    for (const auto& w : r.body.get(QStringLiteral("items")).items())
      if (w.get(QStringLiteral("workspaceId")).str() == ws_) {
        stillMember = true;
        wsName_ = w.get(QStringLiteral("displayName")).stringOr(ws_);
      }
    if (!stillMember) {
      clearScopeState(QStringLiteral("revoked"));
      ws_.clear();
      emit workspaceChanged();
    }
    if (ws_.isEmpty() && r.body.get(QStringLiteral("items")).size() > 0) switchWorkspace(r.body.get(QStringLiteral("items")).at(0).get(QStringLiteral("workspaceId")).str());
  }, false);
}

void ShellController::clearScopeState(const QString& reason) {
  scopeGen_++;
  if (!ws_.isEmpty()) rpc_->unsubscribe(ws_);
  for (auto* v : views_) {
    v->clearScope();
    v->deleteLater();
  }
  views_.clear();
  currentApp_ = nullptr;
  emit currentAppChanged();
  for (auto* m : {members_, apps_, runs_, policies_, jobs_, incidents_, proposals_, notifications_, backups_, revisions_, operations_}) m->clear();
  actions_->clearAll();
  actionKeys_.clear();
  actionReqs_.clear();
  actionNames_.clear();
  canvas_->clear();
  intentDraft_.clear();
  intentKey_.clear();
  transcriptText_.clear();
  maintState_ = JValue::object();
  writesStopped_ = false;
  if (auto* cb = QGuiApplication::clipboard()) cb->clear(QClipboard::Clipboard);  // no clipboard across workspaces
  if (confirm_.value(QStringLiteral("visible")).toBool()) {
    auto done = confirmDone_;
    confirmDone_ = {};
    confirm_.clear();
    emit confirmChanged();
    if (done) done(false);
  }
  setNotice(QString());
  emit draftsChanged();
  emit pagesChanged();
  emit scopeCleared(reason);
}

void ShellController::switchWorkspace(const QString& id) {
  if (id == ws_ && !storeUUID_.isEmpty()) return;
  saveLayout();
  clearScopeState(QStringLiteral("workspace"));
  ws_ = id;
  storeUUID_.clear();
  wsName_ = id;
  for (int i = 0; i < workspaces_->count(); ++i)
    if (workspaces_->at(i).get(QStringLiteral("workspaceId")).str() == id) wsName_ = workspaces_->at(i).get(QStringLiteral("displayName")).stringOr(id);
  emit workspaceChanged();
  attach(id, false);
}

void ShellController::attach(const QString& ws, bool resync) {
  JValue args = JValue::object({{QStringLiteral("workspaceId"), ws}, {QStringLiteral("expectedClientEpoch"), double(clientEpoch_)}});
  ShellRequest r = shellAction(QStringLiteral("workspaces.attach"), args);
  const int gen = scopeGen_;
  sendNative(r, uuid(), [this, ws, gen, resync](const RpcReply& rep) {
    if (gen != scopeGen_ || ws != ws_) {
      lateDropped_++;
      return;
    }
    if (!rep.ok()) {
      setNotice(describeError(rep.errorCode, rep.errorMessage));
      reportError(rep.errorCode);
      return;
    }
    const qint64 ce = qint64(rep.body.get(QStringLiteral("clientEpoch")).toNumber());
    const QString store = rep.body.get(QStringLiteral("storeUUID")).stringOr(QString());
    if ((ce > 0 && ce != clientEpoch_) || (!storeUUID_.isEmpty() && store != storeUUID_)) {
      // The store was restored/replaced: everything from the old epoch is dropped.
      if (resync) clearScopeState(QStringLiteral("epoch"));
      else scopeGen_++;
    }
    if (ce > 0) clientEpoch_ = ce;
    storeUUID_ = store;
    emit workspaceChanged();
    rpc_->subscribe(ws, qint64(rep.body.get(QStringLiteral("cursor")).toNumber()), clientEpoch_, sessionEpoch_);
    loadLayout();
    loadAll();
  }, false);
}

void ShellController::onGap(const QString& ws) {
  if (ws != ws_) return;
  // EVENT_GAP: take a full snapshot (attach) first, then subscribe from its cursor.
  attach(ws, true);
}

void ShellController::loadMachine() {
  request(QStringLiteral("machine.status"), JValue::object(), [this](const RpcReply& r) {
    if (!r.ok()) return;
    machineStatus_ = r.body;
    const JValue& c = r.body.get(QStringLiteral("components"));
    auto up = [&](const char* k) {
      const JValue& v = c.get(QString::fromLatin1(k));
      return v.isMissing() || v.str() == QLatin1String("ok") || v.str() == QLatin1String("ready");
    };
    const bool h = up("host"), m = up("model"), b = up("broker");
    if (m != modelAvailable_ || b != brokerAvailable_) {
      modelAvailable_ = m;
      brokerAvailable_ = b;
      emit statusChanged();
    }
    markHostDown(!h);
    emit machineChanged();
  }, false);
  request(QStringLiteral("machine.capabilities"), JValue::object(), [this](const RpcReply& r) {
    if (!r.ok()) return;
    capabilities_ = r.body;
    emit machineChanged();
  }, false);
}

void ShellController::applyApps(const JValue& state) {
  apps_->setItems(state.get(QStringLiteral("apps")));
  QList<QPair<QString, QString>> list;
  for (const auto& a : state.get(QStringLiteral("apps")).items()) list << qMakePair(a.get(QStringLiteral("appId")).str(), a.get(QStringLiteral("title")).stringOr(a.get(QStringLiteral("appId")).str()));
  const JValue saved = canvas_->toJson();
  canvas_->setApps(list);
  Q_UNUSED(saved);
}

void ShellController::loadAll() {
  request(QStringLiteral("state"), JValue::object(), [this](const RpcReply& r) {
    if (r.ok()) applyApps(r.body);
  });
  refreshPage();
}

void ShellController::refreshPage() {
  if (ws_.isEmpty() || !sessionBound_) return;
  const JValue a = JValue::object({{QStringLiteral("workspaceId"), ws_}});
  auto list = [this](JsonListModel* m) {
    return [this, m](const RpcReply& r) {
      if (r.ok()) {
        m->setItems(r.body.get(QStringLiteral("items")));
        emit pagesChanged();
      }
    };
  };
  const QString p = page_;
  if (p == QLatin1String("home") || p == QLatin1String("tasks")) request(QStringLiteral("runs.list"), a, list(runs_));
  if (p == QLatin1String("home")) request(QStringLiteral("notifications"), a, list(notifications_));
  if (p == QLatin1String("workspaces")) {
    loadWorkspaces();
    request(QStringLiteral("members.list"), a, list(members_));
  }
  if (p == QLatin1String("policies")) {
    request(QStringLiteral("maintenance.policies"), a, list(policies_));
    request(QStringLiteral("maintenance.jobs"), a, list(jobs_));
    request(QStringLiteral("maintenance.state"), a, [this](const RpcReply& r) {
      if (r.ok()) {
        maintState_ = r.body;
        emit pagesChanged();
      }
    });
  }
  if (p == QLatin1String("incidents")) request(QStringLiteral("incidents"), a, list(incidents_));
  if (p == QLatin1String("proposals")) request(QStringLiteral("proposals"), a, list(proposals_));
  if (p == QLatin1String("backup")) request(QStringLiteral("backups.list"), a, list(backups_));
  if (p == QLatin1String("update")) request(QStringLiteral("updates.status"), a, [this](const RpcReply& r) {
      if (r.ok()) {
        updateStatus_ = r.body;
        emit machineChanged();
      }
    }, false);
  if (p == QLatin1String("diagnostics")) request(QStringLiteral("systemOperations"), a, list(operations_));
  if (p == QLatin1String("app") && currentApp_) {
    request(QStringLiteral("apps.revisions"), JValue::object({{QStringLiteral("appId"), currentApp_->appId()}}), list(revisions_));
  }
  if (p == QLatin1String("hardware") || p == QLatin1String("login")) loadMachine();
}

// ------------------------------------------------------------------ apps
QObject* ShellController::appView(const QString& appId) {
  if (ws_.isEmpty()) return nullptr;
  auto it = views_.find(appId);
  if (it != views_.end()) return it.value();
  auto* v = new AppViewModel(appId, this, this);
  v->setDisabled(readOnly() || writesStopped_);
  views_.insert(appId, v);
  request(QStringLiteral("apps.get"), JValue::object({{QStringLiteral("appId"), appId}}), [this, v](const RpcReply& r) {
    if (!views_.values().contains(v)) return;
    if (r.ok()) v->setDetail(r.body);
  });
  return v;
}

void ShellController::openApp(const QString& appId) {
  currentApp_ = qobject_cast<AppViewModel*>(appView(appId));
  emit currentAppChanged();
  setCurrentPage(QStringLiteral("app"));
}

void ShellController::expandCard(const QString& appId, bool on) {
  canvas_->setExpanded(appId, on);  // expansion never triggers a model call; it only shows the app's own view
  saveLayout();
}

QString ShellController::layoutFile() const {
  QString u = userId_.isEmpty() ? QStringLiteral("user") : userId_;
  return layoutDir_ + QStringLiteral("/layout-") + u + QLatin1Char('-') + ws_ + QStringLiteral(".json");
}

void ShellController::saveLayout() {
  if (ws_.isEmpty() || canvas_->count() == 0) return;
  canvas_->save(layoutFile());
}

void ShellController::loadLayout() { canvas_->load(layoutFile()); }

// ------------------------------------------------------------------ page actions
static const QHash<QString, QPair<QString, QString>>& pollRoutes() {
  static const QHash<QString, QPair<QString, QString>> m = {
      {QStringLiteral("runs.submit"), {QStringLiteral("runs.get"), QStringLiteral("runId")}},
      {QStringLiteral("runs.cancel"), {QStringLiteral("runs.get"), QStringLiteral("runId")}},
      {QStringLiteral("app.deploy"), {QStringLiteral("deployment.get"), QStringLiteral("deploymentId")}},
      {QStringLiteral("machine.plan"), {QStringLiteral("machine.get"), QStringLiteral("operationId")}},
      {QStringLiteral("machine.confirm"), {QStringLiteral("machine.get"), QStringLiteral("operationId")}},
      {QStringLiteral("machine.cancel"), {QStringLiteral("machine.get"), QStringLiteral("operationId")}},
      {QStringLiteral("restores.plan"), {QStringLiteral("restores.status"), QStringLiteral("restoreId")}},
      {QStringLiteral("restores.confirm"), {QStringLiteral("restores.status"), QStringLiteral("restoreId")}},
      {QStringLiteral("updates.prepare"), {QStringLiteral("updates.status"), QString()}},
      {QStringLiteral("updates.activate"), {QStringLiteral("updates.status"), QString()}},
      {QStringLiteral("updates.cancel"), {QStringLiteral("updates.status"), QString()}},
      {QStringLiteral("systemAction.confirm"), {QStringLiteral("systemAction.get"), QStringLiteral("actionId")}},
      {QStringLiteral("systemAction.cancel"), {QStringLiteral("systemAction.get"), QStringLiteral("actionId")}},
      {QStringLiteral("systemAction.resolve"), {QStringLiteral("systemAction.get"), QStringLiteral("actionId")}},
  };
  return m;
}

QString ShellController::act(const QString& name, const QVariantMap& argsV, const QString& label) {
  JValue args = JValue::fromVariant(argsV);
  if (!args.isObject()) args = JValue::object();
  if (!ws_.isEmpty() && !args.has(QStringLiteral("workspaceId"))) args.set(QStringLiteral("workspaceId"), ws_);
  ShellRequest r;
  try {
    r = shellAction(name, args);
  } catch (const std::exception& e) {
    setNotice(QString::fromUtf8(e.what()));
    return {};
  }
  const bool mutating = r.write && !name.endsWith(QLatin1String(".list")) && name != QLatin1String("events.ack");
  const bool system = name.startsWith(QLatin1String("systemAction.")) || name.startsWith(QLatin1String("machine."));
  if (mutating && !canWrite(name.startsWith(QLatin1String("systemAction.")))) {
    setNotice(readOnly() ? S("只读状态（工作区服务不可用、断开或已锁定），不能提交") : writesStopped_ ? S("成员权限已撤销，写入已停止") : S("系统执行服务不可用，系统动作已暂停"));
    return {};
  }
  if (locked_ && (system || name.startsWith(QLatin1String("members.")) || name.startsWith(QLatin1String("updates.")))) {
    setNotice(S("会话已锁定：机器动作、成员变更和系统更新不可进行"));
    return {};
  }
  if (name == QLatin1String("runs.submit") && !modelAvailable_) {
    setNotice(describeError(QStringLiteral("MODEL_UNAVAILABLE"), QString()));
    return {};
  }
  const QString key = r.write ? uuid() : QString();
  const QString id = actions_->add(name, label, r, key);
  actionKeys_[id] = key;
  actionReqs_[id] = r;
  actionNames_[id] = name;
  sendNative(r, key, [this, id](const RpcReply& rep) { trackReply(id, rep); });
  return id;
}

void ShellController::retryAction(const QString& id) {
  if (!actionReqs_.contains(id)) return;
  const QString st = actions_->stateOf(id);
  // Only an unknown/failed-by-transport result is retried, and always with the SAME idempotency key.
  if (st != QLatin1String("unknown") && st != QLatin1String("failed")) return;
  actions_->setState(id, QStringLiteral("accepted"), S("重试（同一幂等键）"));
  sendNative(actionReqs_[id], actionKeys_[id], [this, id](const RpcReply& rep) { trackReply(id, rep); });
}

void ShellController::trackReply(const QString& id, const RpcReply& rep) {
  const QString name = actionNames_.value(id);
  if (!rep.ok()) {
    reportError(rep.errorCode);
    actions_->setState(id, rep.errorCode == QLatin1String("EFFECT_UNKNOWN") ? QStringLiteral("unknown") : QStringLiteral("failed"), describeError(rep.errorCode, rep.errorMessage));
    return;
  }
  if (!hostAvailable_) markHostDown(false);
  JValue b = rep.body;
  if (b.get(QStringLiteral("state")).isNullish() && b.get(QStringLiteral("phase")).isNullish() && b.get(QStringLiteral("status")).isString()) b.set(QStringLiteral("state"), b.get(QStringLiteral("status")));
  QString st = displayState(b);
  const auto poll = pollRoutes().value(name);
  if (st == QLatin1String("needs_confirmation")) {
    actions_->setState(id, st, S("等待你在可信确认层确认"));
    const JValue plan = b;
    showPlan(name, plan, [this, id, name, plan](bool yes) {
      if (!yes) {
        actions_->setState(id, QStringLiteral("reconciled"), S("你取消了，未执行"));
        if (name == QLatin1String("machine.plan")) act(QStringLiteral("machine.cancel"), {{QStringLiteral("operationId"), plan.get(QStringLiteral("operationId")).toVariant()}});
        return;
      }
      QString cname;
      QVariantMap args;
      if (name == QLatin1String("machine.plan")) {
        cname = QStringLiteral("machine.confirm");
        args = {{QStringLiteral("operationId"), plan.get(QStringLiteral("operationId")).toVariant()},
                {QStringLiteral("planHash"), plan.get(QStringLiteral("planHash")).toVariant()},
                {QStringLiteral("ticket"), plan.get(QStringLiteral("ticket")).toVariant()}};
      } else if (name == QLatin1String("restores.plan")) {
        cname = QStringLiteral("restores.confirm");
        args = {{QStringLiteral("restoreId"), plan.get(QStringLiteral("restoreId")).toVariant()}, {QStringLiteral("planHash"), plan.get(QStringLiteral("planHash")).toVariant()}};
      } else {
        cname = QStringLiteral("systemAction.confirm");
        args = {{QStringLiteral("actionId"), plan.get(QStringLiteral("actionId")).toVariant()}, {QStringLiteral("planHash"), plan.get(QStringLiteral("planHash")).toVariant()}};
      }
      const QString cid = act(cname, args, S("确认 ") + actions_->row(id).get(QStringLiteral("label")).str());
      actions_->setState(id, QStringLiteral("in_progress"), S("已确认，执行中"), JValue::object({{QStringLiteral("confirmAction"), cid}}));
    });
    return;
  }
  if (st == QLatin1String("reconciled") || poll.first.isEmpty()) {
    // No dedicated status route: re-read the authoritative lists before calling it reconciled.
    refreshPage();
    if (name.startsWith(QLatin1String("app.")) || name.startsWith(QLatin1String("proposal."))) loadAll();
    actions_->setState(id, QStringLiteral("reconciled"), asText(b.get(QStringLiteral("state")).isMissing() ? b.get(QStringLiteral("phase")) : b.get(QStringLiteral("state"))));
    if (name == QLatin1String("machine.confirm") || name.startsWith(QLatin1String("machine."))) loadMachine();
    return;
  }
  actions_->setState(id, st);
  JValue args = JValue::object();
  if (!poll.second.isEmpty()) {
    JValue v = b.get(poll.second);
    if (v.isMissing()) v = actionReqs_[id].params.get(poll.second);
    args.set(poll.second, v);
  }
  pollAction(id, poll.first, args, 0);
}

void ShellController::pollAction(const QString& id, const QString& getName, const JValue& args, int attempt) {
  const int gen = scopeGen_;
  QTimer::singleShot(attempt == 0 ? 200 : 1000, this, [this, id, getName, args, attempt, gen] {
    if (gen != scopeGen_) return;
    request(getName, args, [this, id, getName, args, attempt](const RpcReply& r) {
      if (!r.ok()) {
        actions_->setState(id, QStringLiteral("unknown"), describeError(r.errorCode, r.errorMessage));
        return;
      }
      JValue body = r.body;
      if (body.get(QStringLiteral("state")).isNullish() && body.get(QStringLiteral("phase")).isNullish() && body.get(QStringLiteral("status")).isString())
        body.set(QStringLiteral("state"), body.get(QStringLiteral("status")));  // runs/invocations report `status`
      const QString st = displayState(body);
      if (st == QLatin1String("reconciled") || st == QLatin1String("failed")) {
        actions_->setState(id, st, asText(r.body.get(QStringLiteral("state")).isMissing() ? r.body.get(QStringLiteral("phase")) : r.body.get(QStringLiteral("state"))));
        refreshPage();
        const QString name = actionNames_.value(id);
        if (name == QLatin1String("machine.confirm") && r.body.get(QStringLiteral("actionKind")).str() == QLatin1String("display.mode.set")) startDisplayRevert(r.body.get(QStringLiteral("previous")));
        if (getName == QLatin1String("updates.status")) {
          updateStatus_ = r.body;
          emit machineChanged();
        }
        return;
      }
      if (st == QLatin1String("unknown")) {
        actions_->setState(id, st, S("执行端无法判断结果：保留已知事实，等待核对，不会换 ID 重做"));
        return;
      }
      actions_->setState(id, st);
      if (attempt < 300) pollAction(id, getName, args, attempt + 1);
      else actions_->setState(id, QStringLiteral("unknown"), S("长时间未结束，稍后在操作中心查看"));
    });
  });
}

void ShellController::submitIntent(const QString& text, const QString& targetAppId) {
  if (text.trimmed().isEmpty()) return;
  if (intentKey_.isEmpty()) intentKey_ = uuid();
  QVariantMap args{{QStringLiteral("intent"), text}, {QStringLiteral("targetAppId"), targetAppId.isEmpty() ? QVariant::fromValue(nullptr) : QVariant(targetAppId)}};
  if (!targetAppId.isEmpty()) {
    for (int i = 0; i < apps_->count(); ++i)
      if (apps_->at(i).get(QStringLiteral("appId")).str() == targetAppId) args[QStringLiteral("expectedAppEpoch")] = apps_->at(i).get(QStringLiteral("appEpoch")).toVariant();
  }
  const QString id = act(QStringLiteral("runs.submit"), args, S("意图：") + text.left(40));
  if (!id.isEmpty()) {
    setIntentDraft(QString());
    intentKey_.clear();
  }
}

void ShellController::loadTranscript(const QString& runId) {
  request(QStringLiteral("runs.transcript"), JValue::object({{QStringLiteral("runId"), runId}}), [this](const RpcReply& r) {
    if (!r.ok()) return;
    QStringList lines;
    for (const auto& i : r.body.get(QStringLiteral("items")).items()) lines << i.get(QStringLiteral("role")).stringOr(i.get(QStringLiteral("kind")).str()) + QStringLiteral("：") + i.get(QStringLiteral("text")).stringOr(QString());
    transcriptText_ = lines.join(QLatin1Char('\n')).left(64 * 1024);
    emit pagesChanged();
  });
}

// ------------------------------------------------------------------ hardware (spec §12)
void ShellController::hardware(const QString& kind, const QVariantMap& params) {
  QVariantMap p = params;
  if (kind == QLatin1String("display.mode.set")) {
    p[QStringLiteral("revertAfterSeconds")] = displayRevertSeconds();
    // remember the current mode to restore it if the user does not keep the new one
    const JValue outs = capabilities_.get(QStringLiteral("hardware")).get(QStringLiteral("display")).get(QStringLiteral("outputs"));
    for (const auto& o : outs.items())
      if (o.get(QStringLiteral("name")).str() == params.value(QStringLiteral("output")).toString())
        displayPrevious_ = JValue::object({{QStringLiteral("output"), o.get(QStringLiteral("name"))}, {QStringLiteral("mode"), o.get(QStringLiteral("current"))}, {QStringLiteral("scale"), o.get(QStringLiteral("scale"))}});
  }
  act(QStringLiteral("machine.plan"), {{QStringLiteral("actionKind"), kind}, {QStringLiteral("params"), p}}, kind);
}

void ShellController::startDisplayRevert(const JValue& previous) {
  if (previous.isObject()) displayPrevious_ = previous;
  displayRevertLeft_ = displayRevertSeconds();
  displayRevert_.start();
  emit displayRevertChanged();
}

void ShellController::keepDisplay() {
  displayRevert_.stop();
  displayRevertLeft_ = 0;
  displayPrevious_ = JValue();
  emit displayRevertChanged();
}

// ------------------------------------------------------------------ trusted confirmation layer
void ShellController::showPlan(const QString& kind, const JValue& plan, std::function<void(bool)> done) {
  const JValue& sum = plan.get(QStringLiteral("summary"));
  auto pick = [&](std::initializer_list<const char*> keys) -> QString {
    for (const char* k : keys) {
      const JValue& v = sum.has(QString::fromLatin1(k)) ? sum.get(QString::fromLatin1(k)) : plan.get(QString::fromLatin1(k));
      if (!v.isNullish()) return asText(v);
    }
    return QString();
  };
  QString perm = pick({"permissionChange", "grantChange", "permissions"});
  confirm_ = {{QStringLiteral("visible"), true},
              {QStringLiteral("kind"), kind},
              {QStringLiteral("title"), pick({"title", "label", "actionKind", "handlerId"})},
              {QStringLiteral("user"), userName_ + QStringLiteral("（") + role_ + QStringLiteral("）")},
              {QStringLiteral("workspace"), wsName_.isEmpty() ? S("机器") : wsName_},
              {QStringLiteral("resource"), pick({"resource", "resourceId", "resourceIds", "target"})},
              {QStringLiteral("effect"), pick({"effect", "effects", "impact"})},
              {QStringLiteral("planHash"), plan.get(QStringLiteral("planHash")).stringOr(QString())},
              {QStringLiteral("version"), pick({"version", "resourceGeneration", "appEpoch", "releaseId", "baseline"})},
              {QStringLiteral("permissionChange"), perm.isEmpty() ? S("无权限变化") : perm},
              {QStringLiteral("unknownNote"), S("如果执行后结果无法确定，AgentOS 会保留已知事实并请你核对，不会自动换 ID 重做。")},
              {QStringLiteral("appText"), QString()},
              {QStringLiteral("sessionEpoch"), sessionEpoch_},
              {QStringLiteral("clientEpoch"), clientEpoch_},
              {QStringLiteral("workspaceId"), ws_},
              {QStringLiteral("stale"), false}};
  confirmDone_ = std::move(done);
  emit confirmChanged();
}

void ShellController::openSystemPlan(const QString& actionId) {
  if (actionId.isEmpty()) return;
  request(QStringLiteral("systemAction.get"), JValue::object({{QStringLiteral("actionId"), actionId}}), [this, actionId](const RpcReply& r) {
    if (!r.ok()) return;
    if (displayState(r.body) != QLatin1String("needs_confirmation")) return;
    JValue plan = r.body;
    if (!plan.has(QStringLiteral("actionId"))) plan.set(QStringLiteral("actionId"), actionId);
    const QString id = actions_->add(QStringLiteral("systemAction.plan"), S("系统动作计划"), ShellRequest{QStringLiteral("workspace.forward"), JValue::object(), JValue::null(), QStringLiteral("apps.systemactions.post"), true}, QString());
    actionNames_[id] = QStringLiteral("systemAction.plan");
    RpcReply rep;
    rep.body = plan;
    trackReply(id, rep);
  });
}

void ShellController::askAppConfirm(const QString& appTitle, const QString& text, std::function<void(bool)> done) {
  confirm_ = {{QStringLiteral("visible"), true},
              {QStringLiteral("kind"), QStringLiteral("app")},
              {QStringLiteral("title"), S("应用请求确认")},
              {QStringLiteral("user"), userName_},
              {QStringLiteral("workspace"), wsName_},
              {QStringLiteral("resource"), appTitle},
              {QStringLiteral("appText"), text},
              {QStringLiteral("planHash"), QString()},
              {QStringLiteral("version"), QString()},
              {QStringLiteral("permissionChange"), S("无（这是应用自己的操作确认，不改变任何权限）")},
              {QStringLiteral("unknownNote"), S("以下文字由应用提供，不代表系统批准。")},
              {QStringLiteral("sessionEpoch"), sessionEpoch_},
              {QStringLiteral("clientEpoch"), clientEpoch_},
              {QStringLiteral("workspaceId"), ws_},
              {QStringLiteral("stale"), false}};
  confirmDone_ = std::move(done);
  emit confirmChanged();
}

void ShellController::confirmAccept() {
  if (!confirm_.value(QStringLiteral("visible")).toBool()) return;
  // A confirmation is bound to the identity/epochs it was shown under; anything else is a stale plan.
  if (confirm_.value(QStringLiteral("sessionEpoch")).toLongLong() != sessionEpoch_ || confirm_.value(QStringLiteral("clientEpoch")).toLongLong() != clientEpoch_ ||
      confirm_.value(QStringLiteral("workspaceId")).toString() != ws_ || locked_) {
    confirm_[QStringLiteral("stale")] = true;
    emit confirmChanged();
    setNotice(describeError(QStringLiteral("PLAN_STALE"), QString()));
    return;
  }
  auto done = confirmDone_;
  confirmDone_ = {};
  confirm_.clear();
  emit confirmChanged();
  if (done) done(true);
}

void ShellController::confirmReject() {
  auto done = confirmDone_;
  confirmDone_ = {};
  confirm_.clear();
  emit confirmChanged();
  if (done) done(false);
}

// ------------------------------------------------------------------ events
void ShellController::onEvent(const RpcEvent& e) {
  if (e.workspaceId != ws_) return;
  const QString t = e.type;
  if (t == QLatin1String("membership.revoking") || t == QLatin1String("membership.revoked")) {
    const QString who = e.data.get(QStringLiteral("userId")).stringOr(userId_);
    if (who == userId_) {
      writesStopped_ = true;
      for (auto* v : views_) v->setDisabled(true);
      emit statusChanged();
      if (t == QLatin1String("membership.revoked")) loadWorkspaces();
    } else if (page_ == QLatin1String("workspaces")) {
      refreshPage();
    }
    return;
  }
  if (t == QLatin1String("workspace.state_changed")) {
    loadWorkspaces();
    return;
  }
  if (t == QLatin1String("update.state_changed")) {
    updateStatus_ = e.data;
    emit machineChanged();
    return;
  }
  if (t == QLatin1String("restore.state_changed") || t == QLatin1String("operation.state_changed")) {
    refreshPage();
    return;
  }
  // The Host's own event kinds (app.created/activated/archived/restored…, run.*): the app list and the task list are
  // re-read from the Host (an event is a hint, never data — spec §9.2). Without this the real-gateway Shell kept the
  // list it loaded at bind time (m13: run succeeded, Apps still empty).
  if (t.startsWith(QLatin1String("app.")) && t != QLatin1String("app.changed")) {
    request(QStringLiteral("state"), JValue::object(), [this](const RpcReply& r) {
      if (r.ok()) applyApps(r.body);
    });
  }
  if (t.startsWith(QLatin1String("run.")) && (page_ == QLatin1String("home") || page_ == QLatin1String("tasks"))) {
    request(QStringLiteral("runs.list"), JValue::object({{QStringLiteral("workspaceId"), ws_}}), [this](const RpcReply& r) {
      if (r.ok()) {
        runs_->setItems(r.body.get(QStringLiteral("items")));
        emit pagesChanged();
      }
    });
  }
  if (t == QLatin1String("app.changed") || t == QLatin1String("data.changed") || t == QLatin1String("app.activated") || t.startsWith(QLatin1String("record."))) {
    const QString appId = e.data.get(QStringLiteral("appId")).stringOr(QString());
    if (views_.contains(appId)) {
      request(QStringLiteral("apps.get"), JValue::object({{QStringLiteral("appId"), appId}}), [this, appId](const RpcReply& r) {
        if (r.ok() && views_.contains(appId)) views_[appId]->setDetail(r.body);
      });
    }
  }
}

}  // namespace agentos
