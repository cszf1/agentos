#include "shell_controller.hpp"

#include "error_policy.hpp"

#include <QClipboard>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QtEndian>
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
      // 15 s without "keep": the session agent restores the previous mode itself (spec §12.1); re-read it after that
      QTimer::singleShot(1500, this, [this] { loadSession(); });
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
          {QStringLiteral("protocolErrors"), s.protocolErrors}, {QStringLiteral("lateDropped"), lateDropped_},
          {QStringLiteral("events"), eventsSeen_}, {QStringLiteral("eventsOtherWorkspace"), eventsOther_}, {QStringLiteral("lastEvent"), lastEventType_}};
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
  const bool fromHost = r.methodId == QLatin1String("workspace.forward");
  const quint64 seq = ++sendSeq_;
  rpc_->call(c, [this, s, scoped, fromHost, seq, done = std::move(done)](const RpcReply& rep) {
    if (scoped && !inScope(s)) {
      lateDropped_++;  // a reply for a workspace/epoch/store we have left: never applied
      emit transportChanged();
      return;
    }
    if (fromHost && rep.ok() && !rep.local) {
      cachedAt_ = QDateTime::currentDateTime();
    }
    const quint64 outer = replySeq_;
    replySeq_ = seq;  // Host-health evidence from this reply is ordered by when its request was sent (markHostDown)
    if (done) done(rep);
    replySeq_ = outer;
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
  const bool needsHost = r.methodId == QLatin1String("workspace.forward");
  sendNative(r, QString(), [this, done, needsHost](const RpcReply& rep) {
    if (needsHost && rep.ok() && !rep.local) markHostDown(false);
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
               if (rep.ok() && !rep.local) markHostDown(false);
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
  // A HOST_UNAVAILABLE answer to a request sent while the Host was stopped can arrive after a newer request has already
  // proven the restarted Host up; applying it puts the read-only banner back for a moment (the likely cause of m20 D11
  // run 41917407780: the home cards moved 38px under a click). Evidence older than what is applied is stale, not an outage.
  if (replySeq_) {
    if (replySeq_ < hostEvidenceSeq_) return;
    hostEvidenceSeq_ = replySeq_;
  }
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
  // One bind at a time: after a reconnect every re-sent request answers SESSION_REQUIRED (rebind), and one bind each,
  // each followed by a full reload, queued 713 requests in m13 W05 (run 41167999147). A pending bind is re-sent by
  // the transport on reconnect, so it also covers this call.
  if (bindPending_) return;
  bindPending_ = true;
  request(QStringLiteral("session.bind"), JValue::object(), [this](const RpcReply& r) {
    bindPending_ = false;
    if (!r.ok()) {
      sessionBound_ = false;
      setNotice(describeError(r.errorCode, r.errorMessage));
      emit statusChanged();
      return;
    }
    const QString user = r.body.get(QStringLiteral("userId")).stringOr(QString());
    const qint64 e = qint64(r.body.get(QStringLiteral("sessionEpoch")).toNumber());
    const bool nowLocked = r.body.get(QStringLiteral("locked")).toBool();
    if ((!userId_.isEmpty() && user != userId_) || (e > 0 && e != sessionEpoch_) || (nowLocked && !locked_)) {
      onLocked();
    }
    sessionBound_ = true;
    userId_ = user;
    userName_ = r.body.get(QStringLiteral("userName")).stringOr(userId_);
    role_ = r.body.get(QStringLiteral("role")).stringOr(QString());
    if (e > 0) sessionEpoch_ = e;
    locked_ = nowLocked;
    emit statusChanged();
    loadMachine();
    loadWorkspaces();
    // Automatic transport resubscriptions precede this connection\'s bind and can be refused. A still-visible
    // current workspace does not pass through switchWorkspace(), so explicitly reacquire its snapshot/stream.
    if (!locked_ && !ws_.isEmpty()) attach(ws_, true);
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
  ++scopeGen_;  // pending workspace reads from before this lock must not refill private UI state
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
  withdrawConfirms();  // a pending confirmation is never carried over a lock
  emit draftsChanged();
  emit pagesChanged();
  emit statusChanged();
  emit scopeCleared(QStringLiteral("lock"));
}

// ------------------------------------------------------------------ workspace scope
void ShellController::loadWorkspaces(bool reconcileWrites) {
  const int gen = scopeGen_;
  const quint64 memberGen = membershipGen_;
  request(QStringLiteral("workspaces.list"), JValue::object(), [this, gen, memberGen, reconcileWrites](const RpcReply& r) {
    if (gen != scopeGen_ || memberGen != membershipGen_) {
      ++lateDropped_;
      emit transportChanged();
      return;
    }
    if (!r.ok()) return;
    workspaces_->setItems(r.body.get(QStringLiteral("items")));
    bool stillMember = ws_.isEmpty();
    for (const auto& w : r.body.get(QStringLiteral("items")).items())
      if (w.get(QStringLiteral("workspaceId")).str() == ws_) {
        stillMember = true;
        wsName_ = w.get(QStringLiteral("displayName")).stringOr(ws_);
        const QString role = w.get(QStringLiteral("role")).str();
        if (reconcileWrites && writesStopped_ && (role == QLatin1String("owner") || role == QLatin1String("editor"))) {
          writesStopped_ = false;  // fresh native directory evidence, never the event itself or a Host heartbeat
          for (auto* v : views_) v->setDisabled(readOnly());
          emit statusChanged();
        }
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
  withdrawConfirms();
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
    for (auto* v : views_) {
      if (v->mode() == QLatin1String("loading")) fetchDetail(v);
      else if (resync) v->reload();  // a full re-read includes open app data, not just workspace metadata
    }
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
    // a missing model component says nothing: the Host's state view decides (applyApps)
    const bool b = c.get(QStringLiteral("broker")).isMissing() ? brokerAvailable_ : up("broker");
    const bool m = c.get(QStringLiteral("model")).isMissing() ? modelAvailable_ : up("model");
    if (m != modelAvailable_ || b != brokerAvailable_) {
      modelAvailable_ = m;
      brokerAvailable_ = b;
      emit statusChanged();
    }
    // The native machine status has no Host-health field; absence is not proof of recovery.
    if (!c.get(QStringLiteral("host")).isMissing()) markHostDown(!up("host"));
    emit machineChanged();
  }, false);
  request(QStringLiteral("machine.capabilities"), JValue::object(), [this](const RpcReply& r) {
    if (!r.ok()) return;
    capabilities_ = r.body;
    emit machineChanged();
  }, false);
  if (connected_ && sessionBound_ && !locked_ && !ws_.isEmpty()) {
    // Probe the selected workspace, without attach/start side effects or requiring a user refresh.
    request(QStringLiteral("state"), JValue::object(), [this](const RpcReply& r) { if (r.ok()) applyAvailability(r.body); });
  }
}

void ShellController::applyAvailability(const JValue& state) {
  // The workspace Host's state view says whether generation is possible (its own model configuration). machine.status
  // has no model component, so without this the Shell kept "available" after the Host restarted without a model
  // (m13 O03 run 41143307884: Host logged modelAvailable=false, the submit button stayed enabled).
  const JValue& ma = state.get(QStringLiteral("modelAvailable"));
  if (ma.isBool() && ma.toBool() != modelAvailable_) {
    modelAvailable_ = ma.toBool();
    emit statusChanged();
  }
  const JValue& br = state.get(QStringLiteral("brokerReady"));
  if (br.isBool() && br.toBool() != brokerAvailable_) {
    brokerAvailable_ = br.toBool();
    emit statusChanged();
  }
}

void ShellController::applyApps(const JValue& state) {
  apps_->setItems(state.get(QStringLiteral("apps")));
  applyAvailability(state);
  // An open app view older than the list (a new version activated, the event missed or not carrying the appId) is
  // re-read: its appEpoch guards every write from it, so a stale one turns the next action into APP_EPOCH_STALE
  // (m13 run 41131676224: the version switch after a modify answered 409).
  for (const auto& a : state.get(QStringLiteral("apps")).items()) {
    const QString id = a.get(QStringLiteral("appId")).str();
    const JValue& ep = a.get(QStringLiteral("appEpoch"));
    if (views_.contains(id) && !ep.isNullish() && ep.toNumber() != views_[id]->appEpoch())
      request(QStringLiteral("apps.get"), JValue::object({{QStringLiteral("appId"), id}}), [this, id](const RpcReply& r) {
        if (r.ok() && views_.contains(id)) views_[id]->setDetail(r.body);
      });
  }
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
  // The app list is re-read from the Host on every page refresh as well as on app.* events: events are hints and
  // can be missed (gap, reconnect); a page refresh must never show an app list older than the Host's.
  request(QStringLiteral("state"), JValue::object(), [this](const RpcReply& r) {
    if (r.ok()) applyApps(r.body);
  });
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
  if (p == QLatin1String("hardware")) loadSession();
}

// ------------------------------------------------------------------ apps
QObject* ShellController::appView(const QString& appId) {
  if (ws_.isEmpty()) return nullptr;
  auto it = views_.find(appId);
  if (it != views_.end()) return it.value();
  auto* v = new AppViewModel(appId, this, this);
  v->setDisabled(readOnly() || writesStopped_);
  views_.insert(appId, v);
  // Before the attach answers, a request carries a scope without the store and its reply is dropped: the view
  // would stay "loading" for good (m13 W05 run 41173405389). attach() fetches the detail of such views instead.
  if (!storeUUID_.isEmpty()) fetchDetail(v);
  return v;
}

void ShellController::fetchDetail(AppViewModel* v) {
  request(QStringLiteral("apps.get"), JValue::object({{QStringLiteral("appId"), v->appId()}}), [this, v](const RpcReply& r) {
    if (!views_.values().contains(v)) return;
    if (r.ok()) v->setDetail(r.body);
  });
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
  if ((name == QLatin1String("machine.plan") || name == QLatin1String("machine.users.create")) && !pendingSecret_.isEmpty()) {
    // the secret rides only in this request; actionReqs_ (retry) and the action list never see it
    const QString field = name == QLatin1String("machine.plan") ? QStringLiteral("secret") : QStringLiteral("password");
    ShellRequest withSecret = r;
    JValue b = r.body.isObject() ? r.body : JValue::object();
    b.set(field, pendingSecret_);
    withSecret.body = b;
    JValue shown = b;
    shown.set(field, QStringLiteral("<secret>"));
    lastPlanSent_ = shown.stringify();
    sendNative(withSecret, key, [this, id](const RpcReply& rep) { trackReply(id, rep); });
    return id;
  }
  if (name == QLatin1String("machine.confirm") && !pendingPassword_.isEmpty()) {
    // the administrator password rides only in this request (gateway: PAM, then the one-time ticket); actionReqs_
    // (retry) and the action list never see it, so a retry has to be confirmed (and authenticated) again
    ShellRequest withPassword = r;
    JValue b = r.body.isObject() ? r.body : JValue::object();
    b.set(QStringLiteral("password"), pendingPassword_);
    withPassword.body = b;
    sendNative(withPassword, key, [this, id](const RpcReply& rep) { trackReply(id, rep); });
    return id;
  }
  if (name == QLatin1String("machine.plan")) lastPlanSent_ = r.body.stringify();
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
  if (actionReqs_.value(id).methodId == QLatin1String("workspace.forward") && !rep.local) markHostDown(false);
  JValue b = rep.body;
  if (b.get(QStringLiteral("state")).isNullish() && b.get(QStringLiteral("phase")).isNullish() && b.get(QStringLiteral("status")).isString()) b.set(QStringLiteral("state"), b.get(QStringLiteral("status")));
  QString st = displayState(b);
  const auto poll = pollRoutes().value(name);
  if (st == QLatin1String("needs_confirmation")) {
    actions_->setState(id, st, S("等待你在可信确认层确认"));
    const JValue plan = b;
    // machine.users.create/disable answer with a machine operation plan, confirmed like any machine plan
    const bool machinePlan = name == QLatin1String("machine.plan") || name.startsWith(QLatin1String("machine.users."));
    showPlan(name, plan, [this, id, name, plan, machinePlan](bool yes) {
      if (!yes) {
        actions_->setState(id, QStringLiteral("reconciled"), S("你取消了，未执行"));
        if (machinePlan) act(QStringLiteral("machine.cancel"), {{QStringLiteral("operationId"), plan.get(QStringLiteral("operationId")).toVariant()}});
        return;
      }
      QString cname;
      QVariantMap args;
      if (machinePlan) {
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
  // Lock and logout belong to the login session, not to machined (spec §9.1/§9.4): the session agent runs swaylock
  // (LockedHint only after swaylock confirms) or ends the logind session. machined has no such action kind; before
  // review F02/F12 these buttons (and Ctrl+Alt+L) sent machine.plan and were refused with INVALID_REQUEST.
  if (kind == QLatin1String("session.lock") || kind == QLatin1String("session.logout")) {
    const bool logout = kind == QLatin1String("session.logout");
    if (logout) clearScopeState(QStringLiteral("logout"));   // nothing of this scope survives into the next login
    const QString err = sessionAgent(logout ? QStringLiteral("logout") : QStringLiteral("lock"));
    if (!err.isEmpty()) setNotice((logout ? S("注销失败：") : S("锁定失败：")) + err);
    return;
  }
  // The user's own session settings belong to the login session agent (wpctl / swaymsg as this user), not to machined:
  // no machine plan and no trusted confirmation, like lock/logout.
  if (kind == QLatin1String("audio.volume.set") || kind == QLatin1String("audio.mute.set") || kind == QLatin1String("display.mode.set")) {
    sessionSetting(kind, params);
    return;
  }
  act(QStringLiteral("machine.plan"), {{QStringLiteral("actionKind"), kind}, {QStringLiteral("params"), params}}, kind);
}

QString ShellController::sessionAgent(const QString& op, const QJsonObject& args, QJsonObject* data) {
  // $XDG_RUNTIME_DIR/agentos-session.sock: 4-byte big-endian length + JSON {"op": ...}; the agent checks SO_PEERCRED.
  const QString rt = qEnvironmentVariable("XDG_RUNTIME_DIR");
  if (rt.isEmpty()) return S("没有登录会话运行目录");
  QLocalSocket sock;
  sock.connectToServer(rt + QStringLiteral("/agentos-session.sock"));
  if (!sock.waitForConnected(2000)) return S("会话代理不可用");
  QJsonObject req = args;
  req.insert(QStringLiteral("op"), op);
  const QByteArray body = QJsonDocument(req).toJson(QJsonDocument::Compact);
  QByteArray frame(4, '\0');
  qToBigEndian<quint32>(quint32(body.size()), frame.data());
  frame += body;
  sock.write(frame);
  if (!sock.waitForBytesWritten(2000)) return S("会话代理没有接收请求");
  QByteArray in;
  while (in.size() < 4 && sock.waitForReadyRead(8000)) in += sock.readAll();
  if (in.size() < 4) return op == QLatin1String("logout") ? QString() : S("会话代理没有应答");   // logout may end us first
  const quint32 n = qFromBigEndian<quint32>(in.constData());
  while (quint32(in.size()) < 4 + n && sock.waitForReadyRead(2000)) in += sock.readAll();
  const QJsonObject r = QJsonDocument::fromJson(in.mid(4, int(n))).object();
  if (r.value(QStringLiteral("ok")).toBool()) {
    if (data) *data = r.value(QStringLiteral("data")).toObject();
    return QString();
  }
  return r.value(QStringLiteral("error")).toObject().value(QStringLiteral("message")).toString(S("会话代理拒绝了请求"));
}

void ShellController::createUser(const QString& loginName, const QString& role, const QString& initialPassword) {
  if (initialPassword.isEmpty()) {
    setNotice(S("新用户需要一个初始密码"));
    return;
  }
  pendingSecret_ = initialPassword;
  act(QStringLiteral("machine.users.create"), {{QStringLiteral("loginName"), loginName}, {QStringLiteral("role"), role}}, S("创建用户 ") + loginName);
  pendingSecret_.fill(QLatin1Char('\0'));
  pendingSecret_.clear();
}

void ShellController::hardwareSecret(const QString& kind, const QVariantMap& params, const QString& secret) {
  pendingSecret_ = secret;
  hardware(kind, params);
  pendingSecret_.fill(QLatin1Char('\0'));
  pendingSecret_.clear();
}

void ShellController::sessionSetting(const QString& kind, const QVariantMap& params) {
  if (locked_) {
    setNotice(S("会话已锁定：不能更改设置"));
    return;
  }
  QString op;
  QJsonObject a;
  if (kind == QLatin1String("audio.volume.set")) {
    op = QStringLiteral("audio.setVolume");
    a.insert(QStringLiteral("percent"), qBound(0, params.value(QStringLiteral("percent")).toInt(), 100));
  } else if (kind == QLatin1String("audio.mute.set")) {
    op = QStringLiteral("audio.setMute");
    a.insert(QStringLiteral("muted"), params.value(QStringLiteral("muted")).toBool());
  } else {
    // "1920x1080" from the page, or explicit width/height; the agent accepts only a mode its output offers
    const QStringList wh = params.value(QStringLiteral("mode")).toString().split(QLatin1Char('x'));
    op = QStringLiteral("display.set");
    a.insert(QStringLiteral("name"), params.value(QStringLiteral("output")).toString());
    a.insert(QStringLiteral("width"), params.contains(QStringLiteral("width")) ? params.value(QStringLiteral("width")).toInt() : wh.value(0).toInt());
    a.insert(QStringLiteral("height"), params.contains(QStringLiteral("height")) ? params.value(QStringLiteral("height")).toInt() : wh.value(1).toInt());
    a.insert(QStringLiteral("scale"), params.value(QStringLiteral("scale"), 1).toDouble());
  }
  QJsonObject data;
  const QString err = sessionAgent(op, a, &data);
  if (!err.isEmpty()) setNotice(S("设置失败：") + err);
  else if (op == QLatin1String("display.set")) startDisplayRevert(data.value(QStringLiteral("revertInSeconds")).toInt(displayRevertSeconds()));
  loadSession();
}

void ShellController::loadSession() {
  QJsonObject data;
  const QString err = sessionAgent(QStringLiteral("status"), {}, &data);
  session_ = err.isEmpty() ? JValue::fromVariant(data.toVariantMap()) : JValue::object({{QStringLiteral("available"), false}, {QStringLiteral("reason"), err}});
  emit machineChanged();
}

void ShellController::startDisplayRevert(int seconds) {
  displayRevertLeft_ = seconds > 0 ? seconds : displayRevertSeconds();
  displayRevert_.start();
  emit displayRevertChanged();
}

void ShellController::keepDisplay() {
  displayRevert_.stop();
  displayRevertLeft_ = 0;
  emit displayRevertChanged();
  const QString err = sessionAgent(QStringLiteral("display.keep"));
  if (!err.isEmpty()) setNotice(S("保留显示设置失败：") + err);
}

// ------------------------------------------------------------------ trusted confirmation layer
namespace {
struct PlanFacts {
  const char* what;
  const char* risk;
  const char* reversible;
};
// What each machine action does, its risk and whether it can be undone, shown on the trusted layer. A kind that is
// not listed is shown as unknown rather than guessed.
PlanFacts planFacts(const QString& kind) {
  static const QHash<QString, PlanFacts> m = {
      {QStringLiteral("network.wifi.connect"), {"连接 Wi-Fi 网络", "低：切换这台机器的网络连接", "可以：断开或连回原来的网络"}},
      {QStringLiteral("network.wifi.disconnect"), {"断开 Wi-Fi", "中：断开后这台机器可能没有网络", "可以：重新连接"}},
      {QStringLiteral("time.timezone.set"), {"更改系统时区", "低：所有用户看到的时间都会变", "可以：改回原来的时区"}},
      {QStringLiteral("time.ntp.enable"), {"开启自动对时", "低：系统时间会按网络时间校准", "可以"}},
      {QStringLiteral("power.reboot"), {"重启这台机器", "高：所有会话断开，没保存的内容会丢失", "不能撤销"}},
      {QStringLiteral("power.poweroff"), {"关闭这台机器", "高：所有会话断开，没保存的内容会丢失", "不能撤销"}},
      {QStringLiteral("workspaces.runWhenLoggedOut"), {"更改注销后是否继续运行", "中：注销后这个工作区的应用仍会运行", "可以：再改回来"}},
      {QStringLiteral("users.create"), {"创建用户", "中：新用户可以登录这台机器", "可以：停用这个用户"}},
      {QStringLiteral("users.disable"), {"停用用户", "高：这个用户立即无法登录，会话会结束", "需要管理员重新处理"}},
      {QStringLiteral("admin.update"), {"系统更新步骤", "高：激活后会重启并试启动新版本", "可以：试启动失败会自动回到旧版本"}},
      {QStringLiteral("admin.backup"), {"创建整机备份", "低：只读取数据，备份期间写入会暂停", "可以：删除这个备份"}},
      {QStringLiteral("admin.restore"), {"从备份恢复", "高：会用备份里的数据替换现在的数据", "不能撤销"}},
      {QStringLiteral("restores.confirm"), {"执行恢复计划", "高：会用备份里的数据替换现在的数据", "不能撤销"}},
      {QStringLiteral("workspaces.delete"), {"删除工作区", "高：工作区和它的数据会被删除", "不能撤销"}},
  };
  return m.value(kind, {"", "未知（系统没有提供这个操作的风险说明）", "未知"});
}
}  // namespace

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
  const QString actionKind = pick({"actionKind", "kind"});
  const PlanFacts facts = planFacts(actionKind);
  const JValue& impact = plan.get(QStringLiteral("impact"));
  auto side = [&](const char* a, const char* b) -> QString {
    for (const JValue* src : {&impact, &sum})
      for (const char* k : {a, b})
        if (src->isObject() && !src->get(QString::fromLatin1(k)).isNullish()) return asText(src->get(QString::fromLatin1(k)));
    return QString();
  };
  QString before = side("from", "before"), after = side("to", "after");
  if (actionKind == QLatin1String("workspaces.runWhenLoggedOut") && impact.get(QStringLiteral("enabled")).isBool()) {
    const bool on = impact.get(QStringLiteral("enabled")).toBool();
    before = on ? S("注销后停止") : S("注销后继续运行");
    after = on ? S("注销后继续运行") : S("注销后停止");
  }
  QString expires;
  const JValue& exp = plan.get(QStringLiteral("expiresAt"));
  if (exp.isNumber()) {
    const qint64 left = qint64(exp.toNumber()) - QDateTime::currentMSecsSinceEpoch();
    expires = left <= 0 ? S("已过期") : S("%1 分钟后过期").arg((left + 59999) / 60000);
  }
  confirm_ = {{QStringLiteral("visible"), true},
              {QStringLiteral("kind"), kind},
              {QStringLiteral("what"), *facts.what ? QString::fromUtf8(facts.what) : pick({"title", "label", "actionKind", "kind", "handlerId"})},
              {QStringLiteral("before"), before.isEmpty() ? S("—") : before},
              {QStringLiteral("after"), after.isEmpty() ? S("—") : after},
              {QStringLiteral("risk"), QString::fromUtf8(facts.risk)},
              {QStringLiteral("reversible"), QString::fromUtf8(facts.reversible)},
              {QStringLiteral("expires"), expires.isEmpty() ? S("系统没有给出过期时间") : expires},
              {QStringLiteral("admin"), plan.get(QStringLiteral("admin")).toBool()},
              {QStringLiteral("title"), pick({"title", "label", "actionKind", "kind", "handlerId"})},
              {QStringLiteral("user"), userName_ + QStringLiteral("（") + role_ + QStringLiteral("）")},
              {QStringLiteral("workspace"), wsName_.isEmpty() ? S("机器") : wsName_},
              {QStringLiteral("resource"), pick({"resource", "resourceId", "resourceIds", "target"})},
              {QStringLiteral("effect"), pick({"effect", "effects", "impact"})},
              {QStringLiteral("planHash"), plan.get(QStringLiteral("planHash")).stringOr(QString())},
              {QStringLiteral("version"), pick({"version", "resourceGeneration", "appEpoch", "releaseId", "baseline"})},
              {QStringLiteral("permissionChange"), perm.isEmpty() ? S("无权限变化") : perm},
              {QStringLiteral("unknownNote"), S("如果执行后结果无法确定，AgentOS 会保留已知事实并请你核对，不会自动换 ID 重做。")},
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
  // An app's confirmation is the app's own question: it gets an ordinary dialog, never the trusted system layer, so
  // an app cannot dress its text up as a system approval (product decision v3).
  if (appConfirmDone_) appConfirmDone_(false);  // one at a time: an older unanswered question counts as refused
  appConfirm_ = {{QStringLiteral("visible"), true},
                 {QStringLiteral("app"), appTitle},
                 {QStringLiteral("text"), text},
                 {QStringLiteral("sessionEpoch"), sessionEpoch_},
                 {QStringLiteral("clientEpoch"), clientEpoch_},
                 {QStringLiteral("workspaceId"), ws_}};
  appConfirmDone_ = std::move(done);
  emit appConfirmChanged();
}

void ShellController::appConfirmAnswer(bool yes) {
  if (!appConfirm_.value(QStringLiteral("visible")).toBool()) return;
  const bool current = appConfirm_.value(QStringLiteral("sessionEpoch")).toLongLong() == sessionEpoch_ && appConfirm_.value(QStringLiteral("clientEpoch")).toLongLong() == clientEpoch_ &&
                       appConfirm_.value(QStringLiteral("workspaceId")).toString() == ws_ && !locked_;
  auto done = appConfirmDone_;
  appConfirmDone_ = {};
  appConfirm_.clear();
  emit appConfirmChanged();
  if (done) done(yes && current);
}

void ShellController::withdrawConfirms() {
  if (confirm_.value(QStringLiteral("visible")).toBool()) {
    auto done = confirmDone_;
    confirmDone_ = {};
    confirm_.clear();
    emit confirmChanged();
    if (done) done(false);
  }
  if (appConfirm_.value(QStringLiteral("visible")).toBool()) {
    auto done = appConfirmDone_;
    appConfirmDone_ = {};
    appConfirm_.clear();
    emit appConfirmChanged();
    if (done) done(false);
  }
}

void ShellController::confirmAccept(const QString& adminPassword) {
  if (!confirm_.value(QStringLiteral("visible")).toBool()) return;
  if (confirm_.value(QStringLiteral("admin")).toBool() && adminPassword.isEmpty()) {
    setNotice(S("这是管理员操作：请先输入你自己的管理员密码"));
    return;
  }
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
  const bool admin = confirm_.value(QStringLiteral("admin")).toBool();
  confirm_.clear();
  emit confirmChanged();
  if (admin) pendingPassword_ = adminPassword;
  if (done) done(true);
  pendingPassword_.fill(QLatin1Char('\0'));
  pendingPassword_.clear();
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
  eventsSeen_++;
  lastEventType_ = e.type;
  if (e.workspaceId != ws_) {
    eventsOther_++;
    return;
  }
  const QString t = e.type;
  if (t == QLatin1String("membership.revoking") || t == QLatin1String("membership.revoked")) {
    const JValue& subject = e.data.get(QStringLiteral("userId"));
    const bool ambiguous = !subject.isString() || subject.str().isEmpty();
    if (ambiguous || subject.str() == userId_) {
      ++membershipGen_;
      writesStopped_ = true;
      for (auto* v : views_) v->setDisabled(true);
      emit statusChanged();
      if (ambiguous) loadWorkspaces(true);  // old event envelopes require fresh native authority, not a guessed self-id
      else if (t == QLatin1String("membership.revoked")) loadWorkspaces();
    } else if (page_ == QLatin1String("workspaces")) {
      refreshPage();
    }
    return;
  }
  if (t == QLatin1String("workspace.state_changed")) {
    const QString appId = e.data.get(QStringLiteral("appId")).stringOr(QString());
    const QString source = e.data.get(QStringLiteral("source")).stringOr(QString());
    if (!appId.isEmpty() && views_.contains(appId)) views_[appId]->reload();
    if (!source.startsWith(QLatin1String("record."))) {
      loadWorkspaces();
      if (!appId.isEmpty()) request(QStringLiteral("state"), JValue::object(), [this](const RpcReply& r) { if (r.ok()) applyApps(r.body); });
    }
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
