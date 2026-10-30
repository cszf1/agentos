#pragma once
// The Shell's single state owner (spec §11): session, workspace scope, page data, async actions, degraded modes,
// the trusted confirmation layer, lock/scope clearing. Talks to the gateway only through RpcClient (worker thread).
#include "app_view.hpp"
#include "canvas_model.hpp"
#include "json_list_model.hpp"
#include "request_sink.hpp"
#include "rpc_client.hpp"
#include "shell_actions.hpp"

#include <QDateTime>
#include <QObject>
#include <QPointer>
#include <QTimer>

namespace agentos {

/** Async action rows (spec §11: accepted / in progress / needs confirmation / reconciled result). */
class ActionTracker : public JsonListModel {
  Q_OBJECT
 public:
  using JsonListModel::JsonListModel;
  QString add(const QString& name, const QString& label, const ShellRequest& req, const QString& key);
  void setState(const QString& id, const QString& state, const QString& detail = QString(), const JValue& extra = JValue());
  JValue row(const QString& id) const;
  Q_INVOKABLE QString stateOf(const QString& id) const { return row(id).get(QStringLiteral("state")).stringOr(QString()); }
  void clearAll();

 private:
  std::vector<JValue> rows_;
  void publish();
};

class ShellController : public QObject, public RequestSink {
  Q_OBJECT
  // session / connection
  Q_PROPERTY(bool connected READ connected NOTIFY statusChanged)
  Q_PROPERTY(bool sessionBound READ sessionBound NOTIFY statusChanged)
  Q_PROPERTY(bool locked READ locked NOTIFY statusChanged)
  Q_PROPERTY(QString userName READ userName NOTIFY statusChanged)
  Q_PROPERTY(QString role READ role NOTIFY statusChanged)
  Q_PROPERTY(qint64 sessionEpoch READ sessionEpoch NOTIFY statusChanged)
  Q_PROPERTY(bool hostAvailable READ hostAvailable NOTIFY statusChanged)
  Q_PROPERTY(bool modelAvailable READ modelAvailable NOTIFY statusChanged)
  Q_PROPERTY(bool brokerAvailable READ brokerAvailable NOTIFY statusChanged)
  Q_PROPERTY(bool readOnly READ readOnly NOTIFY statusChanged)
  Q_PROPERTY(bool writesStopped READ writesStopped NOTIFY statusChanged)
  Q_PROPERTY(QString cachedAt READ cachedAt NOTIFY statusChanged)
  Q_PROPERTY(QString banner READ banner NOTIFY statusChanged)
  Q_PROPERTY(QVariantMap machineStatus READ machineStatus NOTIFY machineChanged)
  Q_PROPERTY(QVariantMap capabilities READ capabilities NOTIFY machineChanged)
  Q_PROPERTY(QVariantMap updateStatus READ updateStatus NOTIFY machineChanged)
  Q_PROPERTY(QVariantMap setupStatus READ setupStatus NOTIFY machineChanged)
  Q_PROPERTY(QVariantMap maintenanceState READ maintenanceState NOTIFY pagesChanged)
  Q_PROPERTY(QString diagnosticsText READ diagnosticsText NOTIFY pagesChanged)
  Q_PROPERTY(QString transcriptText READ transcriptText NOTIFY pagesChanged)
  Q_PROPERTY(QVariantMap transportStats READ transportStats NOTIFY transportChanged)
  // workspace
  Q_PROPERTY(QString workspaceId READ workspaceId NOTIFY workspaceChanged)
  Q_PROPERTY(QString workspaceName READ workspaceName NOTIFY workspaceChanged)
  Q_PROPERTY(qint64 clientEpoch READ clientEpoch NOTIFY workspaceChanged)
  Q_PROPERTY(QObject* workspaces READ workspaces CONSTANT)
  Q_PROPERTY(QObject* members READ members CONSTANT)
  Q_PROPERTY(QObject* apps READ apps CONSTANT)
  Q_PROPERTY(QObject* canvas READ canvas CONSTANT)
  Q_PROPERTY(QObject* runs READ runs CONSTANT)
  Q_PROPERTY(QObject* policies READ policies CONSTANT)
  Q_PROPERTY(QObject* jobs READ jobs CONSTANT)
  Q_PROPERTY(QObject* incidents READ incidents CONSTANT)
  Q_PROPERTY(QObject* proposals READ proposals CONSTANT)
  Q_PROPERTY(QObject* notifications READ notifications CONSTANT)
  Q_PROPERTY(QObject* backups READ backups CONSTANT)
  Q_PROPERTY(QObject* revisions READ revisions CONSTANT)
  Q_PROPERTY(QObject* operations READ operations CONSTANT)
  Q_PROPERTY(QObject* actions READ actions CONSTANT)
  Q_PROPERTY(QObject* currentApp READ currentApp NOTIFY currentAppChanged)
  Q_PROPERTY(QString currentPage READ currentPage WRITE setCurrentPage NOTIFY pageChanged)
  Q_PROPERTY(QString intentDraft READ intentDraft WRITE setIntentDraft NOTIFY draftsChanged)
  Q_PROPERTY(QString notice READ notice NOTIFY noticeChanged)
  Q_PROPERTY(qreal uiScale READ uiScale WRITE setUiScale NOTIFY uiScaleChanged)
  // trusted confirmation layer
  Q_PROPERTY(QVariantMap confirm READ confirm NOTIFY confirmChanged)
  Q_PROPERTY(int displayRevertLeft READ displayRevertLeft NOTIFY displayRevertChanged)

 public:
  explicit ShellController(QString socketPath, QObject* parent = nullptr);
  ~ShellController() override;
  static const QString kMachineScope;

  void start();
  RpcClient* rpc() const { return rpc_; }
  void setLayoutDir(const QString& d) { layoutDir_ = d; }

  bool connected() const { return connected_; }
  bool sessionBound() const { return sessionBound_; }
  bool locked() const { return locked_; }
  QString userName() const { return userName_; }
  QString role() const { return role_; }
  qint64 sessionEpoch() const { return sessionEpoch_; }
  bool hostAvailable() const { return hostAvailable_; }
  bool modelAvailable() const { return modelAvailable_; }
  bool brokerAvailable() const { return brokerAvailable_; }
  bool readOnly() const { return !connected_ || !hostAvailable_ || locked_; }
  bool writesStopped() const { return writesStopped_; }
  QString cachedAt() const { return cachedAt_.isValid() ? cachedAt_.toString(QStringLiteral("yyyy-MM-dd HH:mm:ss")) : QString(); }
  QString banner() const;
  QVariantMap machineStatus() const { return machineStatus_.toVariant().toMap(); }
  QVariantMap capabilities() const { return capabilities_.toVariant().toMap(); }
  QVariantMap updateStatus() const { return updateStatus_.toVariant().toMap(); }
  QVariantMap setupStatus() const { return machineStatus_.get(QStringLiteral("setup")).toVariant().toMap(); }
  QVariantMap maintenanceState() const { return maintState_.toVariant().toMap(); }
  QString diagnosticsText() const { return diagnosticsText_; }
  QString transcriptText() const { return transcriptText_; }
  QVariantMap transportStats() const;
  QString workspaceId() const { return ws_; }
  QString workspaceName() const { return wsName_; }
  qint64 clientEpoch() const { return clientEpoch_; }
  QObject* workspaces() const { return workspaces_; }
  QObject* members() const { return members_; }
  QObject* apps() const { return apps_; }
  QObject* canvas() const { return canvas_; }
  QObject* runs() const { return runs_; }
  QObject* policies() const { return policies_; }
  QObject* jobs() const { return jobs_; }
  QObject* incidents() const { return incidents_; }
  QObject* proposals() const { return proposals_; }
  QObject* notifications() const { return notifications_; }
  QObject* backups() const { return backups_; }
  QObject* revisions() const { return revisions_; }
  QObject* operations() const { return operations_; }
  QObject* actions() const { return actions_; }
  QObject* currentApp() const { return currentApp_; }
  QString currentPage() const { return page_; }
  void setCurrentPage(const QString& p);
  QString intentDraft() const { return intentDraft_; }
  void setIntentDraft(const QString& t);
  QString notice() const { return notice_; }
  qreal uiScale() const { return uiScale_; }
  void setUiScale(qreal s);
  QVariantMap confirm() const { return confirm_; }
  int displayRevertLeft() const { return displayRevertLeft_; }

  // RequestSink
  void sendForward(const ForwardRequest& r, std::function<void(const RpcReply&)> done) override;
  void openSystemPlan(const QString& actionId) override;
  void askAppConfirm(const QString& appTitle, const QString& text, std::function<void(bool)> done) override;
  void reportError(const QString& code) override;
  bool canWrite(bool systemAction) const override;

  // QML API
  Q_INVOKABLE void reconnect();
  Q_INVOKABLE void rebind();
  Q_INVOKABLE void switchWorkspace(const QString& workspaceId);
  Q_INVOKABLE void openApp(const QString& appId);
  Q_INVOKABLE QObject* appView(const QString& appId);
  Q_INVOKABLE QString act(const QString& name, const QVariantMap& args = {}, const QString& label = QString());
  Q_INVOKABLE void retryAction(const QString& actionId);
  Q_INVOKABLE void submitIntent(const QString& text, const QString& targetAppId);
  Q_INVOKABLE void refreshPage();
  Q_INVOKABLE void hardware(const QString& actionKind, const QVariantMap& params);
  Q_INVOKABLE void keepDisplay();
  Q_INVOKABLE void confirmAccept();
  Q_INVOKABLE void confirmReject();
  Q_INVOKABLE void expandCard(const QString& appId, bool on);
  Q_INVOKABLE void saveLayout();
  Q_INVOKABLE void zoom(int step);
  Q_INVOKABLE void loadTranscript(const QString& runId);
  Q_INVOKABLE void dismissNotice() { setNotice(QString()); }
  /** Test hook / session agent signal path: the session was locked (clears sensitive state). */
  Q_INVOKABLE void onLocked();
  void applyStatusForTest(const JValue& status) { applySessionStatus(status); }
  int lateDropped() const { return lateDropped_; }
  int scopeGeneration() const { return scopeGen_; }
  QString layoutFile() const;

 signals:
  void statusChanged();
  void machineChanged();
  void pagesChanged();
  void transportChanged();
  void workspaceChanged();
  void currentAppChanged();
  void pageChanged();
  void draftsChanged();
  void noticeChanged();
  void uiScaleChanged();
  void confirmChanged();
  void displayRevertChanged();
  /** QML fields drop their text and any uncommitted IME preedit (lock, logout, workspace switch). */
  void scopeCleared(QString reason);

 private:
  struct Scope {
    QString ws;
    qint64 clientEpoch = 0;
    QString storeUUID;
    int gen = 0;
  };
  RpcClient* rpc_;
  bool connected_ = false, sessionBound_ = false, locked_ = false, hostAvailable_ = true, modelAvailable_ = true, brokerAvailable_ = true, writesStopped_ = false;
  QString userId_, userName_, role_;
  qint64 sessionEpoch_ = 1;
  QString ws_, wsName_, storeUUID_;
  qint64 clientEpoch_ = 1;
  int scopeGen_ = 0;
  int lateDropped_ = 0;
  int eventsSeen_ = 0;    // diagnostics: every event frame, and those for another workspace
  int eventsOther_ = 0;
  QString lastEventType_;
  QDateTime cachedAt_;
  JValue machineStatus_ = JValue::object(), capabilities_ = JValue::object(), updateStatus_ = JValue::object(), maintState_ = JValue::object();
  QString diagnosticsText_, transcriptText_;
  JsonListModel *workspaces_, *members_, *apps_, *runs_, *policies_, *jobs_, *incidents_, *proposals_, *notifications_, *backups_, *revisions_, *operations_;
  ActionTracker* actions_;
  CanvasModel* canvas_;
  QHash<QString, AppViewModel*> views_;
  QPointer<AppViewModel> currentApp_;
  QString page_ = QStringLiteral("home");
  QString intentDraft_, intentKey_, notice_;
  qreal uiScale_ = 1.0;
  QVariantMap confirm_;
  std::function<void(bool)> confirmDone_;
  QTimer statusPoll_, displayRevert_;
  int displayRevertLeft_ = 0;
  JValue displayPrevious_;
  QString layoutDir_;
  QHash<QString, QString> actionKeys_;
  QHash<QString, ShellRequest> actionReqs_;
  QHash<QString, QString> actionNames_;

  Scope scope() const { return {ws_, clientEpoch_, storeUUID_, scopeGen_}; }
  bool inScope(const Scope& s) const { return s.gen == scopeGen_ && s.ws == ws_ && s.clientEpoch == clientEpoch_ && s.storeUUID == storeUUID_; }
  void sendNative(const ShellRequest& r, const QString& key, std::function<void(const RpcReply&)> done, bool scoped = true);
  void request(const QString& name, const JValue& args, std::function<void(const RpcReply&)> done, bool scoped = true);
  void setNotice(const QString& t);
  void onConnection(bool up);
  void bind();
  void applySessionStatus(const JValue& s);
  void pollStatus();
  void loadWorkspaces();
  void attach(const QString& ws, bool resync);
  void loadAll();
  void loadMachine();
  void onEvent(const RpcEvent& e);
  void onGap(const QString& ws);
  void clearScopeState(const QString& reason);
  void applyApps(const JValue& state);
  void trackReply(const QString& id, const RpcReply& r);
  void pollAction(const QString& id, const QString& getName, const JValue& args, int attempt);
  void showPlan(const QString& kind, const JValue& plan, std::function<void(bool)> done);
  void markHostDown(bool down);
  void startDisplayRevert(const JValue& previous);
  void loadLayout();
};

}  // namespace agentos
