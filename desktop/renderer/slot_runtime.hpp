#pragma once
// Slot Tree runtime (spec §10.2): binding resolution, visibleWhen, the render snapshot the QML layer draws from,
// typed form state, selection, and command assembly with idempotency keys. Same semantics as
// packages/contracts/src/v1_0/slot-vectors.ts (checked by tests/slot_vectors.cpp). Pure data: nothing here is ever
// turned into QML, JS or rich text.
#include "jvalue.hpp"
#include "slot_validator.hpp"

#include <QMap>
#include <QStringList>
#include <functional>
#include <optional>

namespace agentos {

struct ForwardRequest {
  QString methodId = QStringLiteral("workspace.forward");
  QString routeId;
  JValue params = JValue::object();
  JValue body;
  bool write = false;
  QString idempotencyKey;
  JValue toJson() const;  // {methodId, routeId, params, body, write, idempotencyKey}
  /** The native-rpc/1 body of workspace.forward: {routeId, params, body}. */
  JValue forwardBody() const;
};

/** Registered Host routes (docs/contracts/forward-routes.json); anything else is refused locally. */
bool forwardRouteIsWrite(const QString& routeId, bool* known = nullptr);
ForwardRequest makeForward(const QString& routeId, const JValue& params, const JValue& body, const QString& key);

struct Notice {
  QString kind;  // info | ok | error
  QString text;
  bool isSet() const { return !kind.isEmpty(); }
  JValue toJson() const;
};

struct ClickResult {
  QString kind = QStringLiteral("none");  // none | error | confirm | request
  Notice notice;
  QString confirmText;
  std::optional<ForwardRequest> request;
  JValue toJson() const;
};

struct Outcome {
  enum Kind { InvocationSucceeded, InvocationFailed, InvocationRunning, Plan, Network, ApiError } kind = Network;
  int commitCount = 0;
  QString code, message;
  bool confirmationRequired = true;
  QString actionId;
  static Outcome fromJson(const JValue& v);
};

struct RespondResult {
  Notice notice;
  bool reload = false;
  QString openPlan;
  JValue toJson() const;
};

struct AppIdentity {
  QString appId;
  double appEpoch = 0;
  QString revisionId;
};

class SlotRuntime {
 public:
  using KeyFactory = std::function<QString()>;
  SlotRuntime();
  /** Load a code bundle (formatVersion 2/3). Returns false (and keeps issues) when the defensive check rejects it. */
  bool load(const JValue& bundle, const AppIdentity& app);
  bool valid() const { return valid_; }
  const QVector<SlotIssue>& issues() const { return issues_; }
  const JValue& bundle() const { return bundle_; }
  const AppIdentity& app() const { return app_; }
  void setKeyFactory(KeyFactory f) { newKey_ = std::move(f); }

  QVector<ForwardRequest> queryRequests() const;
  bool applyQuery(const QString& source, const JValue& output, const QString& revisionId, double appEpoch);

  JValue render() const;  // array of slot entries (toolbar, main, aside)

  // interaction
  void typeText(const QString& formId, const QString& name, const QString& raw);
  void choose(const QString& formId, const QString& name, const QString& value);
  void check(const QString& formId, const QString& name, bool on);
  void toggle(const QString& selectionId, const QString& id, bool on);
  void setPage(const QString& path, int page) { pages_[path] = page; }
  void setTab(const QString& path, int index) { tabs_[path] = index; }
  ClickResult click(const QString& path);  // throws std::runtime_error for an unknown path
  ClickResult confirm(bool accept);
  RespondResult respond(const Outcome& o);  // throws when nothing is in flight
  void switchRevision(const JValue& bundle, const AppIdentity& app);
  void confirmNewVersion();
  void clearScope();
  void setDisabled(bool d) { disabled_ = d; }
  bool disabled() const { return disabled_; }
  bool busy() const { return busy_; }
  bool staleInput() const { return staleInput_; }
  const Notice& notice() const { return notice_; }
  JValue formsSnapshot() const;  // missing values encoded as {"$missing":true}
  JValue selectionsSnapshot() const;
  QString validateForm(const QString& formId, const JValue& values) const;
  const JValue& formValues(const QString& formId) const;
  bool hasPendingConfirm() const { return pendingConfirm_.has_value(); }
  bool hasInflight() const { return inflight_.has_value(); }
  QString pendingKey() const { return pendingKey_ ? pendingKey_->second : QString(); }
  /** Inputs that must be cleared on lock (all unsubmitted form text). */
  void clearUnsubmittedInput();

 private:
  struct Found {
    JValue node, item;
    bool inItem = false;
    QString formId;
  };
  struct Inflight {
    bool system = false;
    JValue p, spec;
  };
  JValue bundle_, view_;
  AppIdentity app_;
  bool valid_ = false;
  QVector<SlotIssue> issues_;
  QMap<QString, JValue> sources_;
  JValue forms_ = JValue::object();       // formId -> object (insertion order kept)
  JValue selections_ = JValue::object();  // selectionId -> array of ids
  QMap<QString, int> pages_, tabs_;
  bool busy_ = false, disabled_ = false, staleInput_ = false;
  Notice notice_;
  std::optional<std::pair<QString, QString>> pendingKey_;  // sig, key
  std::optional<Inflight> inflight_;
  std::optional<std::pair<JValue, JValue>> pendingConfirm_;  // props, item
  KeyFactory newKey_;

  JValue resolve(const JValue& v, const JValue& item, bool inItem) const;
  bool visible(const JValue& node, const JValue& item, bool inItem) const;
  JValue node(const JValue& n, const QString& path, const QString& formId, int depth, int& counter, const JValue& item, bool inItem) const;
  JValue table(const JValue& p, const QString& path, const JValue& item, bool inItem) const;
  JValue kanban(const JValue& p, const JValue& item, bool inItem) const;
  JValue chart(const JValue& p, const JValue& item, bool inItem) const;
  JValue list(const JValue& n, const JValue& p, const QString& path, const QString& formId, int depth, const JValue& item, bool inItem) const;
  std::optional<Found> findNode(const QString& path) const;
  JValue inputNode(const QString& formId, const QString& name) const;
  void setField(const QString& formId, const QString& name, const JValue& v);
  struct Assembled {
    JValue input;
    QString error;
  };
  Assembled assemble(const JValue& p, const JValue& item, bool requireSelection) const;
  ClickResult sendCommand(const JValue& p, const JValue& input);
  QString keyFor(const QString& sig);
};

/** JavaScript Number(string) (StringToNumber), used for integer-mode TextInput. */
double jsStringToNumber(const QString& s);
/** String.prototype.trim() whitespace set. */
QString jsTrim(const QString& s);
QString jsNumberString(const JValue& v);
JValue encodeMissing(const JValue& v);  // undefined -> {"$missing":true}, recursively
JValue decodeMissing(const JValue& v);  // the inverse
int countTemplateNodes(const JValue& nodes);

}  // namespace agentos
