#pragma once
// One app on the canvas: a code app (Slot Tree) or a formatVersion 1 records app; an unsupported/invalid bundle
// becomes an error card with a version-switch entry (never a blank desktop).
#include "records_view.hpp"
#include "request_sink.hpp"
#include "slot_models.hpp"
#include "slot_runtime.hpp"

#include <QAbstractTableModel>
#include <QObject>
#include <QPointer>
#include <QTimer>

namespace agentos {

class RecordsModel : public QAbstractTableModel {
  Q_OBJECT
  Q_PROPERTY(QStringList headers READ headers NOTIFY reset)
  Q_PROPERTY(int rows READ rows NOTIFY reset)
 public:
  using QAbstractTableModel::QAbstractTableModel;
  int rowCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(items_.size()); }
  int columnCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(columns_.size()); }
  QVariant data(const QModelIndex& i, int role) const override;
  QHash<int, QByteArray> roleNames() const override { return {{Qt::DisplayRole, "display"}}; }
  QStringList headers() const { return headers_; }
  int rows() const { return int(items_.size()); }
  Q_INVOKABLE QString cellAt(int r, int c) const;
  void set(const JValue& bundle, const JValue& items);
  const JValue& record(int r) const { return items_[size_t(r)]; }

 signals:
  void reset();

 private:
  JValue fields_;
  QStringList columns_, headers_;
  std::vector<JValue> items_;
};

class AppViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString appId READ appId CONSTANT)
  Q_PROPERTY(double appEpoch READ appEpoch NOTIFY modeChanged)
  Q_PROPERTY(QString mode READ mode NOTIFY modeChanged)  // loading | slot | records | error
  Q_PROPERTY(QString title READ title NOTIFY modeChanged)
  Q_PROPERTY(QString description READ description NOTIFY modeChanged)
  Q_PROPERTY(QString errorText READ errorText NOTIFY modeChanged)
  Q_PROPERTY(QObject* toolbar READ toolbar NOTIFY treeChanged)
  Q_PROPERTY(QObject* main READ mainNode NOTIFY treeChanged)
  Q_PROPERTY(QObject* aside READ aside NOTIFY treeChanged)
  Q_PROPERTY(QVariantMap notice READ notice NOTIFY stateChanged)
  Q_PROPERTY(QStringList sourceErrors READ sourceErrors NOTIFY stateChanged)
  Q_PROPERTY(bool staleInput READ staleInput NOTIFY stateChanged)
  Q_PROPERTY(bool busy READ busy NOTIFY stateChanged)
  // records mode
  Q_PROPERTY(QObject* records READ records CONSTANT)
  Q_PROPERTY(QVariantList recordForm READ recordForm NOTIFY recordsChanged)
  Q_PROPERTY(QVariantMap recordState READ recordState NOTIFY recordsChanged)
  Q_PROPERTY(QVariantList filterFields READ filterFields NOTIFY recordsChanged)
 public:
  AppViewModel(QString appId, RequestSink* sink, QObject* parent = nullptr);
  ~AppViewModel() override;
  QString appId() const { return appId_; }
  double appEpoch() const { return detail_.get(QStringLiteral("appEpoch")).toNumber(); }
  QString mode() const { return mode_; }
  QString title() const { return title_; }
  QString description() const { return description_; }
  QString errorText() const { return errorText_; }
  QObject* toolbar() const { return roots_[0]; }
  QObject* mainNode() const { return roots_[1]; }
  QObject* aside() const { return roots_[2]; }
  QVariantMap notice() const;
  QStringList sourceErrors() const { return sourceErrors_.values(); }
  bool staleInput() const { return rt_.staleInput(); }
  bool busy() const { return rt_.busy(); }
  QObject* records() const { return records_; }
  QVariantList recordForm() const;
  QVariantMap recordState() const;
  QVariantList filterFields() const;
  SlotRuntime& runtime() { return rt_; }

  /** detail = AppDetail from apps.get ({appId, appEpoch, activeRevisionId, bundle}). */
  void setDetail(const JValue& detail);
  /** Test/offline helper: apply data for a source without a request. */
  void applySource(const QString& source, const JValue& output);
  void setDisabled(bool d);
  void clearScope();

  // Slot Tree interaction (QML)
  Q_INVOKABLE void typeText(const QString& formId, const QString& name, const QString& raw);
  Q_INVOKABLE void choose(const QString& formId, const QString& name, const QString& value);
  Q_INVOKABLE void check(const QString& formId, const QString& name, bool on);
  Q_INVOKABLE void toggle(const QString& selectionId, const QString& id, bool on);
  Q_INVOKABLE void setPage(const QString& path, int page);
  Q_INVOKABLE void setTab(const QString& path, int index);
  Q_INVOKABLE void click(const QString& path);
  Q_INVOKABLE void confirmNewVersion();
  Q_INVOKABLE void reload();
  // Records interaction (QML)
  Q_INVOKABLE void setSearch(const QString& q);
  Q_INVOKABLE void setFilter(const QString& key, const QString& value);
  Q_INVOKABLE void pageBy(int delta);
  Q_INVOKABLE void openCreate();
  Q_INVOKABLE void openEdit(int row);
  Q_INVOKABLE void setDraft(const QString& field, const QVariant& raw);
  Q_INVOKABLE void submitRecord();
  Q_INVOKABLE void cancelRecord();
  Q_INVOKABLE void rebaseRecord();
  Q_INVOKABLE void askDelete(int row);
  Q_INVOKABLE void confirmDelete(bool yes);

  int liveNodes() const;

 signals:
  void modeChanged();
  void treeChanged();
  void stateChanged();
  void recordsChanged();
  void revisionChanged();

 private:
  QString appId_;
  RequestSink* sink_;
  SlotRuntime rt_;
  QString mode_ = QStringLiteral("loading"), title_, description_, errorText_;
  SlotItem* roots_[3] = {nullptr, nullptr, nullptr};
  QMap<QString, QString> sourceErrors_;
  QTimer refresh_;
  JValue detail_;
  int generation_ = 0;
  // records
  RecordsModel* records_;
  JValue rbundle_;
  QString q_;
  JValue filters_ = JValue::object();
  int offset_ = 0, total_ = 0;
  struct RForm {
    bool open = false;
    QString mode;
    JValue record, draft = JValue::object(), errors = JValue::object();
    QString key, message;
    double epoch = 0;
    bool busy = false;
  } form_;
  std::optional<std::pair<JValue, QString>> pendingDelete_;
  QString recordsError_;
  QString lifecycle_;

  void rerender();
  void rebuildRoots(const JValue& snap);
  void send(const ForwardRequest& r, std::function<void(const RpcReply&)> done);
  void pollInvocation(const QString& id, int gen, int attempt);
  void loadRecords();
};

}  // namespace agentos
