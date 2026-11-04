#pragma once
// Generic list model over an array of JSON objects (data only). Roles: row (QVariantMap of the object), key, index.
#include "jvalue.hpp"

#include <QAbstractListModel>
#include <QDateTime>

namespace agentos {

class JsonListModel : public QAbstractListModel {
  Q_OBJECT
  Q_PROPERTY(int count READ count NOTIFY countChanged)
  Q_PROPERTY(QString updatedAt READ updatedAt NOTIFY updatedChanged)
 public:
  enum Roles { RowRole = Qt::UserRole + 1, KeyRole, IndexRole };
  explicit JsonListModel(QString keyField = QStringLiteral("id"), QObject* parent = nullptr);
  int rowCount(const QModelIndex& parent = {}) const override;
  QVariant data(const QModelIndex& index, int role) const override;
  QHash<int, QByteArray> roleNames() const override;
  int count() const { return int(items_.size()); }
  QString updatedAt() const { return updatedAt_.isValid() ? updatedAt_.toString(QStringLiteral("HH:mm:ss")) : QString(); }
  void setItems(const JValue& array);
  void clear();
  // out of range reads as missing, never past the end: m20 D11's old by-index read of a row that was not there came back ''
  const JValue& at(int i) const {
    static const JValue none;
    return i >= 0 && i < int(items_.size()) ? items_[size_t(i)] : none;
  }
  Q_INVOKABLE QVariantMap get(int i) const;
  JValue toJson() const { return JValue::array(items_); }

 signals:
  void countChanged();
  void updatedChanged();

 private:
  QString keyField_;
  std::vector<JValue> items_;
  QDateTime updatedAt_;
};

}  // namespace agentos
