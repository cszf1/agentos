#include "app_view.hpp"

#include "error_policy.hpp"

#include <QUuid>

namespace agentos {

static QString newKey() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }

// ------------------------------------------------------------------ RecordsModel
QVariant RecordsModel::data(const QModelIndex& i, int role) const {
  if (role != Qt::DisplayRole) return {};
  return cellAt(i.row(), i.column());
}
QString RecordsModel::cellAt(int r, int c) const {
  if (r < 0 || r >= int(items_.size()) || c < 0 || c >= columns_.size()) return {};
  const QString k = columns_[c];
  return records::displayValue(fields_.get(k), items_[size_t(r)].get(QStringLiteral("data")).get(k));
}
void RecordsModel::set(const JValue& bundle, const JValue& items) {
  beginResetModel();
  fields_ = bundle.get(QStringLiteral("data")).get(QStringLiteral("fields"));
  columns_.clear();
  headers_.clear();
  for (const auto& c : bundle.get(QStringLiteral("view")).get(QStringLiteral("columns")).items()) {
    columns_ << c.str();
    headers_ << fields_.get(c.str()).get(QStringLiteral("label")).str();
  }
  items_.clear();
  for (const auto& x : items.items()) items_.push_back(x);
  endResetModel();
  emit reset();
}

// ------------------------------------------------------------------ AppViewModel
AppViewModel::AppViewModel(QString appId, RequestSink* sink, QObject* parent)
    : QObject(parent), appId_(std::move(appId)), sink_(sink), records_(new RecordsModel(this)) {
  connect(&refresh_, &QTimer::timeout, this, &AppViewModel::reload);
}
AppViewModel::~AppViewModel() = default;

QVariantMap AppViewModel::notice() const {
  if (!rt_.notice().isSet()) return {};
  return {{QStringLiteral("kind"), rt_.notice().kind}, {QStringLiteral("text"), rt_.notice().text}};
}

void AppViewModel::setDetail(const JValue& detail) {
  const QString prevRev = detail_.get(QStringLiteral("activeRevisionId")).stringOr(QString());
  detail_ = detail;
  generation_++;
  const JValue& bundle = detail.get(QStringLiteral("bundle"));
  const int fv = int(bundle.get(QStringLiteral("formatVersion")).toNumber());
  title_ = bundle.get(QStringLiteral("manifest")).get(QStringLiteral("title")).stringOr(appId_);
  description_ = bundle.get(QStringLiteral("manifest")).get(QStringLiteral("description")).stringOr(QString());
  AppIdentity app{appId_, appEpoch(), detail.get(QStringLiteral("activeRevisionId")).stringOr(QString())};
  refresh_.stop();
  if (fv == 1 && bundle.get(QStringLiteral("view")).get(QStringLiteral("kind")).str() == QLatin1String("records")) {
    mode_ = QStringLiteral("records");
    rbundle_ = bundle;
    filters_ = records::keepFilters(bundle, filters_);
    offset_ = 0;
    if (form_.open && form_.epoch != appEpoch()) form_.message = QString::fromUtf8("应用版本已切换，表单已停用。你的输入已保留。");
    emit modeChanged();
    emit recordsChanged();
    loadRecords();
    return;
  }
  if (fv != 2 && fv != 3) {
    mode_ = QStringLiteral("error");
    errorText_ = QString::fromUtf8("原生界面不支持这个应用版本（formatVersion %1）。可以切换到其他版本。").arg(fv);
    emit modeChanged();
    return;
  }
  if (!prevRev.isEmpty() && prevRev != app.revisionId && rt_.bundle().isObject()) {
    rt_.switchRevision(bundle, app);
    emit revisionChanged();
  } else if (prevRev != app.revisionId || !rt_.bundle().isObject()) {
    rt_.load(bundle, app);
  }
  if (!rt_.valid()) {
    mode_ = QStringLiteral("error");
    QStringList lines;
    for (const auto& i : rt_.issues().mid(0, 5)) lines << i.path + QStringLiteral(": ") + i.message;
    errorText_ = QString::fromUtf8("这个界面没有通过原生端的防御性检查，已拒绝渲染：\n") + lines.join(QLatin1Char('\n'));
    emit modeChanged();
    return;
  }
  mode_ = QStringLiteral("slot");
  errorText_.clear();
  emit modeChanged();
  rerender();
  const JValue& r = bundle.get(QStringLiteral("view")).get(QStringLiteral("refresh")).get(QStringLiteral("intervalSeconds"));
  if (r.isNumber() && r.toNumber() >= 5) refresh_.start(int(r.toNumber() * 1000));
  reload();
}

void AppViewModel::applySource(const QString& source, const JValue& output) {
  rt_.applyQuery(source, output, rt_.app().revisionId, rt_.app().appEpoch);
  rerender();
}

void AppViewModel::setDisabled(bool d) {
  if (d == rt_.disabled()) return;
  rt_.setDisabled(d);
  rerender();
}

void AppViewModel::clearScope() {
  rt_.clearScope();
  form_ = RForm{};
  pendingDelete_.reset();
  q_.clear();
  filters_ = JValue::object();
  sourceErrors_.clear();
  generation_++;
  if (mode_ == QLatin1String("slot")) rerender();
  emit recordsChanged();
  emit stateChanged();
}

void AppViewModel::rerender() {
  if (mode_ != QLatin1String("slot")) return;
  rebuildRoots(rt_.render());
  emit stateChanged();
}

void AppViewModel::rebuildRoots(const JValue& snap) {
  bool changed = false;
  const QStringList names = {QStringLiteral("/view/slots/toolbar"), QStringLiteral("/view/slots/main"), QStringLiteral("/view/slots/aside")};
  for (int s = 0; s < 3; ++s) {
    JValue entry;
    for (const auto& e : snap.items())
      if (e.get(QStringLiteral("path")).str() == names[s]) entry = e;
    if (entry.isMissing()) {
      if (roots_[s]) {
        roots_[s]->deleteLater();
        roots_[s] = nullptr;
        changed = true;
      }
      continue;
    }
    if (roots_[s] && roots_[s]->sameShape(entry)) roots_[s]->update(entry);
    else {
      if (roots_[s]) roots_[s]->deleteLater();
      roots_[s] = new SlotItem(entry, this);
      changed = true;
    }
  }
  if (changed) emit treeChanged();
}

int AppViewModel::liveNodes() const {
  int n = 0;
  for (auto* r : roots_)
    if (r) n += r->liveCount();
  return n;
}

void AppViewModel::send(const ForwardRequest& r, std::function<void(const RpcReply&)> done) {
  if (!sink_) {
    RpcReply x;
    x.errorCode = QStringLiteral("HOST_UNAVAILABLE");
    x.local = true;
    done(x);
    return;
  }
  sink_->sendForward(r, std::move(done));
}

void AppViewModel::reload() {
  if (!sink_) return;  // offline preview (tests, health canvas): data comes from applySource()
  if (mode_ == QLatin1String("records")) return loadRecords();
  if (mode_ != QLatin1String("slot")) return;
  const int gen = generation_;
  const auto reqs = rt_.queryRequests();
  const auto names = rt_.bundle().get(QStringLiteral("view")).get(QStringLiteral("dataSources")).keys();
  for (int i = 0; i < reqs.size(); ++i) {
    const QString source = names.value(i);
    send(reqs[i], [this, gen, source](const RpcReply& r) {
      if (gen != generation_) return;  // late answer from another revision/scope
      if (!r.ok()) {
        const QString inv = invocationText(r.errorCode);
        sourceErrors_[source] = QString::fromUtf8("数据加载失败：") + (inv.isEmpty() ? describeError(r.errorCode, r.errorMessage) : inv);
        if (sink_) sink_->reportError(r.errorCode);
        emit stateChanged();
        return;
      }
      sourceErrors_.remove(source);
      rt_.applyQuery(source, r.body.get(QStringLiteral("output")), r.body.get(QStringLiteral("revisionId")).stringOr(QString()), r.body.get(QStringLiteral("appEpoch")).toNumber());
      rerender();
    });
  }
}

void AppViewModel::typeText(const QString& f, const QString& n, const QString& raw) {
  try {
    rt_.typeText(f, n, raw);
  } catch (...) {
    return;
  }
  rerender();
}
void AppViewModel::choose(const QString& f, const QString& n, const QString& v) {
  rt_.choose(f, n, v);
  rerender();
}
void AppViewModel::check(const QString& f, const QString& n, bool on) {
  rt_.check(f, n, on);
  rerender();
}
void AppViewModel::toggle(const QString& s, const QString& id, bool on) {
  rt_.toggle(s, id, on);
  rerender();
}
void AppViewModel::setPage(const QString& p, int page) {
  rt_.setPage(p, page);
  rerender();
}
void AppViewModel::setTab(const QString& p, int i) {
  rt_.setTab(p, i);
  rerender();
}
void AppViewModel::confirmNewVersion() {
  rt_.confirmNewVersion();
  rerender();
}

void AppViewModel::click(const QString& path) {
  ClickResult res;
  try {
    res = rt_.click(path);
  } catch (...) {
    return;
  }
  auto dispatch = [this](const ClickResult& r) {
    rerender();
    if (r.kind != QLatin1String("request") || !r.request) return;
    const bool system = r.request->routeId == QLatin1String("apps.systemactions.post");
    if (sink_ && !sink_->canWrite(system)) {
      rt_.respond(Outcome{Outcome::ApiError, 0, system ? QStringLiteral("BROKER_UNAVAILABLE") : QStringLiteral("HOST_UNAVAILABLE"), QString()});
      rerender();
      return;
    }
    const int gen = generation_;
    send(*r.request, [this, gen, system](const RpcReply& rep) {
      if (gen != generation_ || !rt_.hasInflight()) return;
      Outcome o;
      if (!rep.ok()) {
        if (rep.local && rep.errorCode == QLatin1String("NETWORK")) o.kind = Outcome::Network;
        else {
          o.kind = Outcome::ApiError;
          o.code = rep.errorCode;
          o.message = rep.errorMessage;
          if (sink_) sink_->reportError(rep.errorCode);
        }
      } else if (system) {
        o.kind = Outcome::Plan;
        o.actionId = rep.body.get(QStringLiteral("actionId")).stringOr(QString());
        o.confirmationRequired = rep.body.get(QStringLiteral("confirmationRequired")).isBool() ? rep.body.get(QStringLiteral("confirmationRequired")).toBool() : true;
      } else {
        pollInvocation(rep.body.get(QStringLiteral("invocationId")).stringOr(QString()), gen, 0);
        return;
      }
      RespondResult rr = rt_.respond(o);
      rerender();
      if (!rr.openPlan.isEmpty() && sink_) sink_->openSystemPlan(rr.openPlan);
    });
  };
  if (res.kind == QLatin1String("confirm")) {
    rerender();
    if (!sink_) return;
    sink_->askAppConfirm(title_, res.confirmText, [this, dispatch](bool yes) { dispatch(rt_.confirm(yes)); });
    return;
  }
  dispatch(res);
}

void AppViewModel::pollInvocation(const QString& id, int gen, int attempt) {
  send(makeForward(QStringLiteral("invocations.get"), JValue::object({{QStringLiteral("invocationId"), id}}), JValue::null(), QStringLiteral("read:") + newKey()),
       [this, id, gen, attempt](const RpcReply& r) {
         if (gen != generation_ || !rt_.hasInflight()) return;
         Outcome o;
         const QString st = r.body.get(QStringLiteral("status")).stringOr(QString());
         if (!r.ok()) {
           o.kind = Outcome::ApiError;
           o.code = r.errorCode;
           o.message = r.errorMessage;
         } else if ((st == QLatin1String("accepted") || st == QLatin1String("executing")) && attempt < 100) {
           QTimer::singleShot(300, this, [this, id, gen, attempt] { pollInvocation(id, gen, attempt + 1); });
           return;
         } else if (st == QLatin1String("succeeded")) {
           o.kind = Outcome::InvocationSucceeded;
           const JValue& c = r.body.get(QStringLiteral("commit"));
           o.commitCount = c.get(QStringLiteral("created")).size() + c.get(QStringLiteral("updated")).size() + c.get(QStringLiteral("deleted")).size();
         } else if (st == QLatin1String("failed")) {
           o.kind = Outcome::InvocationFailed;
           o.code = r.body.get(QStringLiteral("error")).get(QStringLiteral("code")).stringOr(QString());
           o.message = r.body.get(QStringLiteral("error")).get(QStringLiteral("message")).stringOr(QString());
         } else {
           o.kind = Outcome::InvocationRunning;
         }
         RespondResult rr = rt_.respond(o);
         rerender();
         if (rr.reload) reload();
       });
}

// ------------------------------------------------------------------ records mode
QVariantList AppViewModel::filterFields() const {
  QVariantList out;
  const JValue& fields = rbundle_.get(QStringLiteral("data")).get(QStringLiteral("fields"));
  for (const auto& k : rbundle_.get(QStringLiteral("view")).get(QStringLiteral("filters")).items()) {
    const JValue& f = fields.get(k.str());
    QVariantList opts;
    if (f.get(QStringLiteral("type")).str() == QLatin1String("boolean")) {
      opts << QVariantMap{{QStringLiteral("value"), QStringLiteral("true")}, {QStringLiteral("label"), QString::fromUtf8("是")}};
      opts << QVariantMap{{QStringLiteral("value"), QStringLiteral("false")}, {QStringLiteral("label"), QString::fromUtf8("否")}};
    } else {
      for (const auto& v : f.get(QStringLiteral("values")).items()) opts << QVariantMap{{QStringLiteral("value"), v.str()}, {QStringLiteral("label"), v.str()}};
    }
    const JValue& cur = filters_.get(k.str());
    out << QVariantMap{{QStringLiteral("key"), k.str()}, {QStringLiteral("label"), f.get(QStringLiteral("label")).str()}, {QStringLiteral("options"), opts}, {QStringLiteral("value"), cur.isMissing() ? QString() : asText(cur)}};
  }
  return out;
}

QVariantList AppViewModel::recordForm() const {
  QVariantList out;
  if (!form_.open) return out;
  const JValue& fields = rbundle_.get(QStringLiteral("data")).get(QStringLiteral("fields"));
  for (const auto& k : rbundle_.get(QStringLiteral("view")).get(QStringLiteral("formFields")).items()) {
    const JValue& f = fields.get(k.str());
    const JValue& v = form_.draft.get(k.str());
    QVariantList opts;
    for (const auto& o : f.get(QStringLiteral("values")).items()) opts << o.str();
    out << QVariantMap{{QStringLiteral("name"), k.str()},
                       {QStringLiteral("label"), f.get(QStringLiteral("label")).str()},
                       {QStringLiteral("type"), f.get(QStringLiteral("type")).str()},
                       {QStringLiteral("options"), opts},
                       {QStringLiteral("maxLength"), f.get(QStringLiteral("maxLength")).isNumber() ? f.get(QStringLiteral("maxLength")).toNumber() : 0.0},
                       {QStringLiteral("value"), v.isBool() ? QVariant(v.toBool()) : QVariant(asText(v))},
                       {QStringLiteral("error"), form_.errors.get(k.str()).stringOr(QString())}};
  }
  return out;
}

QVariantMap AppViewModel::recordState() const {
  const bool writable = [&] {
    for (const auto& c : rbundle_.get(QStringLiteral("manifest")).get(QStringLiteral("capabilities")).items())
      if (c.str() == QLatin1String("records.write")) return true;
    return false;
  }();
  return {{QStringLiteral("q"), q_},
          {QStringLiteral("offset"), offset_},
          {QStringLiteral("total"), total_},
          {QStringLiteral("pageText"), QStringLiteral("%1–%2 / 共 %3 条").arg(total_ == 0 ? 0 : offset_ + 1).arg(std::min(offset_ + records::kPage, total_)).arg(total_)},
          {QStringLiteral("hasPrev"), offset_ > 0},
          {QStringLiteral("hasNext"), offset_ + records::kPage < total_},
          {QStringLiteral("searchable"), rbundle_.get(QStringLiteral("view")).has(QStringLiteral("searchField"))},
          {QStringLiteral("writable"), writable},
          {QStringLiteral("formOpen"), form_.open},
          {QStringLiteral("formMode"), form_.mode},
          {QStringLiteral("formBusy"), form_.busy},
          {QStringLiteral("formStale"), form_.open && form_.epoch != appEpoch()},
          {QStringLiteral("formMessage"), form_.message},
          {QStringLiteral("error"), recordsError_},
          {QStringLiteral("deleteAsk"), pendingDelete_ ? records::displayValue(rbundle_.get(QStringLiteral("data")).get(QStringLiteral("fields")).get(rbundle_.get(QStringLiteral("view")).get(QStringLiteral("titleField")).str()),
                                                                               pendingDelete_->first.get(QStringLiteral("data")).get(rbundle_.get(QStringLiteral("view")).get(QStringLiteral("titleField")).str()))
                                                       : QString()},
          {QStringLiteral("hasDelete"), pendingDelete_.has_value()}};
}

void AppViewModel::loadRecords() {
  if (!sink_) return;
  const int gen = generation_;
  send(records::listRequest(appId_, rbundle_, q_, filters_, offset_), [this, gen](const RpcReply& r) {
    if (gen != generation_) return;
    if (!r.ok()) {
      recordsError_ = describeError(r.errorCode, r.errorMessage);
      if (sink_) sink_->reportError(r.errorCode);
    } else {
      recordsError_.clear();
      total_ = int(r.body.get(QStringLiteral("total")).toNumber());
      records_->set(rbundle_, r.body.get(QStringLiteral("items")));
    }
    emit recordsChanged();
  });
}

void AppViewModel::setSearch(const QString& q) {
  q_ = q.left(128);
  offset_ = 0;
  loadRecords();
}
void AppViewModel::setFilter(const QString& key, const QString& value) {
  filters_ = records::changeFilter(rbundle_, filters_, key, value);
  offset_ = 0;
  loadRecords();
}
void AppViewModel::pageBy(int d) {
  offset_ = std::max(0, offset_ + d * records::kPage);
  loadRecords();
}
void AppViewModel::openCreate() {
  form_ = RForm{true, QStringLiteral("create"), JValue(), records::defaultDraft(rbundle_), JValue::object(), newKey(), QString(), appEpoch(), false};
  emit recordsChanged();
}
void AppViewModel::openEdit(int row) {
  if (row < 0 || row >= records_->rows()) return;
  const JValue& rec = records_->record(row);
  form_ = RForm{true, QStringLiteral("edit"), rec, records::openEdit(rbundle_, rec.get(QStringLiteral("data"))), JValue::object(), newKey(), QString(), appEpoch(), false};
  emit recordsChanged();
}
void AppViewModel::setDraft(const QString& field, const QVariant& raw) {
  const JValue& f = rbundle_.get(QStringLiteral("data")).get(QStringLiteral("fields")).get(field);
  form_.draft.set(field, records::fieldInput(f, JValue::fromVariant(raw)));
  emit recordsChanged();
}
void AppViewModel::cancelRecord() {
  form_ = RForm{};
  emit recordsChanged();
}
void AppViewModel::rebaseRecord() {
  form_.draft = records::rebase(rbundle_, form_.mode, form_.draft);
  form_.epoch = appEpoch();
  form_.key = newKey();
  form_.message.clear();
  form_.errors = JValue::object();
  emit recordsChanged();
}
void AppViewModel::submitRecord() {
  if (!form_.open || form_.busy || form_.epoch != appEpoch()) return;
  if (sink_ && !sink_->canWrite(false)) {
    form_.message = describeError(QStringLiteral("HOST_UNAVAILABLE"), QString());
    emit recordsChanged();
    return;
  }
  form_.errors = records::localIssues(rbundle_, form_.draft);
  if (form_.errors.size() > 0) {
    emit recordsChanged();
    return;
  }
  std::optional<ForwardRequest> req;
  if (form_.mode == QLatin1String("create")) req = records::createRequest(appId_, form_.epoch, form_.draft, form_.key);
  else req = records::editRequest(appId_, form_.epoch, form_.record, form_.draft, form_.key);
  if (!req) {
    cancelRecord();
    return;
  }
  form_.busy = true;
  form_.message.clear();
  emit recordsChanged();
  const int gen = generation_;
  send(*req, [this, gen](const RpcReply& r) {
    if (gen != generation_ || !form_.open) return;
    form_.busy = false;
    if (r.ok()) {
      form_ = RForm{};
      offset_ = 0;
      loadRecords();
    } else {
      if (r.errorCode == QLatin1String("INVALID_RECORD")) {
        for (const auto& i : r.body.get(QStringLiteral("details")).get(QStringLiteral("issues")).items())
          form_.errors.set(i.get(QStringLiteral("path")).str().section(QLatin1Char('/'), -1), i.get(QStringLiteral("message")));
      }
      const bool network = r.local && r.errorCode == QLatin1String("NETWORK");
      form_.message = network ? networkErrorText() : describeError(r.errorCode, r.errorMessage);
      if (records::keyAfter(network ? QStringLiteral("network") : QStringLiteral("server")) == QLatin1String("fresh") && !errorPolicy(r.errorCode).keepKey) form_.key = newKey();
      if (sink_) sink_->reportError(r.errorCode);
      if (r.errorCode == QLatin1String("RECORD_VERSION_STALE") || r.errorCode == QLatin1String("APP_EPOCH_STALE")) loadRecords();
    }
    emit recordsChanged();
  });
}
void AppViewModel::askDelete(int row) {
  if (row < 0 || row >= records_->rows()) return;
  pendingDelete_ = std::make_pair(records_->record(row), newKey());
  emit recordsChanged();
}
void AppViewModel::confirmDelete(bool yes) {
  if (!pendingDelete_) return;
  if (!yes) {
    pendingDelete_.reset();
    emit recordsChanged();
    return;
  }
  auto pd = *pendingDelete_;
  const int gen = generation_;
  send(records::deleteRequest(appId_, appEpoch(), pd.first, pd.second), [this, gen](const RpcReply& r) {
    if (gen != generation_) return;
    if (r.ok()) pendingDelete_.reset();
    else {
      recordsError_ = describeError(r.errorCode, r.errorMessage);
      if (!(r.local && r.errorCode == QLatin1String("NETWORK"))) pendingDelete_.reset();
    }
    loadRecords();
  });
}

}  // namespace agentos
