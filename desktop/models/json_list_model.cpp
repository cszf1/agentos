#include "json_list_model.hpp"

namespace agentos {

JsonListModel::JsonListModel(QString keyField, QObject* parent) : QAbstractListModel(parent), keyField_(std::move(keyField)) {}

int JsonListModel::rowCount(const QModelIndex& parent) const { return parent.isValid() ? 0 : int(items_.size()); }

QVariant JsonListModel::data(const QModelIndex& index, int role) const {
  if (!index.isValid() || index.row() >= int(items_.size())) return {};
  const JValue& v = items_[size_t(index.row())];
  switch (role) {
    case RowRole: return v.toVariant();
    case KeyRole: return asText(v.get(keyField_));
    case IndexRole: return index.row();
    case Qt::DisplayRole: return asText(v.get(keyField_));
  }
  return {};
}

QHash<int, QByteArray> JsonListModel::roleNames() const { return {{RowRole, "row"}, {KeyRole, "key"}, {IndexRole, "rowIndex"}}; }

void JsonListModel::setItems(const JValue& array) {
  beginResetModel();
  items_.clear();
  for (const auto& x : array.items())
    if (x.isObject()) items_.push_back(x);
  endResetModel();
  updatedAt_ = QDateTime::currentDateTime();
  emit countChanged();
  emit updatedChanged();
}

void JsonListModel::clear() {
  beginResetModel();
  items_.clear();
  endResetModel();
  emit countChanged();
}

QVariantMap JsonListModel::get(int i) const {
  if (i < 0 || i >= int(items_.size())) return {};
  return items_[size_t(i)].toVariant().toMap();
}

}  // namespace agentos
