#pragma once
// Stable object tree over the renderer snapshot so QML delegates keep identity (and keyboard focus) across updates.
// SlotItem.data is a QVariantMap of plain values (strings/numbers/bools) — never markup, never code.
#include "jvalue.hpp"

#include <QAbstractListModel>
#include <QAbstractTableModel>
#include <QObject>
#include <QPointer>

namespace agentos {

class SlotTableModel;
class SlotListModel;

class SlotItem : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString path READ path CONSTANT)
  Q_PROPERTY(QString type READ type CONSTANT)
  Q_PROPERTY(bool shown READ shown NOTIFY changed)
  Q_PROPERTY(QVariantMap data READ data NOTIFY changed)
  Q_PROPERTY(QList<QObject*> kids READ kids NOTIFY kidsChanged)
  Q_PROPERTY(QObject* table READ table CONSTANT)
  Q_PROPERTY(QObject* list READ list CONSTANT)
 public:
  SlotItem(const JValue& entry, QObject* parent);
  QString path() const { return path_; }
  QString type() const { return type_; }
  bool shown() const { return shown_; }
  QVariantMap data() const { return data_; }
  QList<QObject*> kids() const { return kids_; }
  QObject* table() const;
  QObject* list() const;
  /** Apply a new snapshot entry with the same path/type; rebuild children only when their shape changed. */
  void update(const JValue& entry);
  bool sameShape(const JValue& entry) const;
  int liveCount() const;

 signals:
  void changed();
  void kidsChanged();

 private:
  QString path_, type_;
  bool shown_ = true;
  QVariantMap data_;
  QList<QObject*> kids_;
  SlotTableModel* table_ = nullptr;
  SlotListModel* list_ = nullptr;
  void setKids(const JValue& children);
};

/** Table rows of the current page (spec: QAbstractItemModel + paging/selection; rowId/pageSize/emptyText). */
class SlotTableModel : public QAbstractTableModel {
  Q_OBJECT
  Q_PROPERTY(int rows READ rows NOTIFY reset)
  Q_PROPERTY(QStringList headers READ headers NOTIFY reset)
 public:
  enum Roles { CellRole = Qt::UserRole + 1, RowIdRole, SelectedRole };
  using QAbstractTableModel::QAbstractTableModel;
  int rowCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(rows_.size()); }
  int columnCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(headers_.size()); }
  QVariant data(const QModelIndex& i, int role) const override;
  QHash<int, QByteArray> roleNames() const override { return {{CellRole, "cell"}, {RowIdRole, "rowId"}, {SelectedRole, "selected"}, {Qt::DisplayRole, "display"}}; }
  int rows() const { return int(rows_.size()); }
  QStringList headers() const { return headers_; }
  Q_INVOKABLE QString rowIdAt(int r) const { return r >= 0 && r < int(rows_.size()) ? rows_[size_t(r)].id : QString(); }
  Q_INVOKABLE bool selectedAt(int r) const { return r >= 0 && r < int(rows_.size()) && rows_[size_t(r)].selected; }
  Q_INVOKABLE QString cellAt(int r, int c) const;
  void setFrom(const JValue& entry);

 signals:
  void reset();

 private:
  struct Row {
    QString id;
    bool selected = false;
    QStringList cells;
  };
  QStringList headers_;
  std::vector<Row> rows_;
};

/** List (slot-tree-v2) items; QML ListView instantiates delegates lazily (only what is in view). */
class SlotListModel : public QAbstractListModel {
  Q_OBJECT
  Q_PROPERTY(int count READ count NOTIFY countChanged)
 public:
  enum Roles { ItemRole = Qt::UserRole + 1, KeyRole };
  using QAbstractListModel::QAbstractListModel;
  int rowCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(items_.size()); }
  QVariant data(const QModelIndex& i, int role) const override;
  QHash<int, QByteArray> roleNames() const override { return {{ItemRole, "itemNode"}, {KeyRole, "itemKey"}}; }
  int count() const { return int(items_.size()); }
  void setFrom(const JValue& entry, QObject* owner);

 signals:
  void countChanged();

 private:
  struct It {
    QString key;
    SlotItem* node = nullptr;
  };
  std::vector<It> items_;
};

/** Live native instances created for List items (spec §10.2: at most 4096 at once, lazily). */
class InstanceBudget : public QObject {
  Q_OBJECT
  Q_PROPERTY(int live READ live NOTIFY liveChanged)
  Q_PROPERTY(int peak READ peak NOTIFY liveChanged)
  Q_PROPERTY(int limit READ limit CONSTANT)
  Q_PROPERTY(int denied READ denied NOTIFY liveChanged)
 public:
  static InstanceBudget* instance();
  int live() const { return live_; }
  int peak() const { return peak_; }
  int limit() const { return limit_; }
  int denied() const { return denied_; }
  Q_INVOKABLE bool acquire(int n);
  Q_INVOKABLE void release(int n);
  void setLimitForTest(int l) { limit_ = l; }
  void resetStats() { peak_ = live_; denied_ = 0; }

 signals:
  void liveChanged();
  void freed();

 private:
  int live_ = 0, peak_ = 0, denied_ = 0, limit_ = 4096;
};

}  // namespace agentos
