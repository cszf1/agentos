#include "slot_models.hpp"

namespace agentos {

static QVariantMap dataOf(const JValue& e) {
  QVariantMap m;
  for (const auto& kv : e.members()) {
    if (kv.first == QLatin1String("children") || kv.first == QLatin1String("items") || kv.first == QLatin1String("rows")) continue;
    m.insert(kv.first, kv.second.toVariant());
  }
  return m;
}

SlotItem::SlotItem(const JValue& e, QObject* parent) : QObject(parent) {
  path_ = e.get(QStringLiteral("path")).stringOr(QString());
  type_ = e.get(QStringLiteral("type")).stringOr(QString());
  if (type_ == QLatin1String("Table")) table_ = new SlotTableModel(this);
  if (type_ == QLatin1String("List")) list_ = new SlotListModel(this);
  update(e);
}

QObject* SlotItem::table() const { return table_; }
QObject* SlotItem::list() const { return list_; }

bool SlotItem::sameShape(const JValue& e) const {
  if (e.get(QStringLiteral("path")).stringOr(QString()) != path_ || e.get(QStringLiteral("type")).stringOr(QString()) != type_) return false;
  return true;
}

void SlotItem::update(const JValue& e) {
  const bool vis = !(e.get(QStringLiteral("visible")).isBool() && !e.get(QStringLiteral("visible")).toBool());
  QVariantMap d = dataOf(e);
  if (d != data_ || vis != shown_) {
    data_ = d;
    shown_ = vis;
    emit changed();
  }
  if (table_) table_->setFrom(e);
  if (list_) list_->setFrom(e, this);
  setKids(e.get(QStringLiteral("children")));
}

void SlotItem::setKids(const JValue& children) {
  bool same = children.size() == kids_.size();
  for (int i = 0; same && i < children.size(); ++i) same = static_cast<SlotItem*>(kids_[i])->sameShape(children.at(i));
  if (same) {
    for (int i = 0; i < children.size(); ++i) static_cast<SlotItem*>(kids_[i])->update(children.at(i));
    return;
  }
  QList<QObject*> old = kids_;
  kids_.clear();
  for (const auto& c : children.items()) kids_ << new SlotItem(c, this);
  emit kidsChanged();
  for (QObject* o : old) o->deleteLater();
}

int SlotItem::liveCount() const {
  int n = 1;
  for (QObject* k : kids_) n += static_cast<SlotItem*>(k)->liveCount();
  return n;
}

QVariant SlotTableModel::data(const QModelIndex& i, int role) const {
  if (!i.isValid() || i.row() >= int(rows_.size())) return {};
  const Row& r = rows_[size_t(i.row())];
  switch (role) {
    case Qt::DisplayRole:
    case CellRole: return i.column() < r.cells.size() ? r.cells[i.column()] : QString();
    case RowIdRole: return r.id;
    case SelectedRole: return r.selected;
  }
  return {};
}

QString SlotTableModel::cellAt(int r, int c) const {
  if (r < 0 || r >= int(rows_.size()) || c < 0 || c >= rows_[size_t(r)].cells.size()) return {};
  return rows_[size_t(r)].cells[c];
}

void SlotTableModel::setFrom(const JValue& e) {
  QStringList h;
  for (const auto& c : e.get(QStringLiteral("columns")).items()) h << asText(c);
  std::vector<Row> rows;
  for (const auto& r : e.get(QStringLiteral("rows")).items()) {
    Row x;
    x.id = r.get(QStringLiteral("id")).str();
    x.selected = r.get(QStringLiteral("selected")).toBool();
    for (const auto& c : r.get(QStringLiteral("cells")).items()) x.cells << c.str();
    rows.push_back(x);
  }
  bool same = h == headers_ && rows.size() == rows_.size();
  for (size_t i = 0; same && i < rows.size(); ++i) same = rows[i].id == rows_[i].id && rows[i].cells == rows_[i].cells && rows[i].selected == rows_[i].selected;
  if (same) return;
  beginResetModel();
  headers_ = h;
  rows_ = std::move(rows);
  endResetModel();
  emit reset();
}

QVariant SlotListModel::data(const QModelIndex& i, int role) const {
  if (!i.isValid() || i.row() >= int(items_.size())) return {};
  if (role == ItemRole) return QVariant::fromValue<QObject*>(items_[size_t(i.row())].node);
  if (role == KeyRole) return items_[size_t(i.row())].key;
  return {};
}

void SlotListModel::setFrom(const JValue& e, QObject* owner) {
  const JValue& items = e.get(QStringLiteral("items"));
  bool same = items.size() == int(items_.size());
  for (int i = 0; same && i < items.size(); ++i) same = items.at(i).get(QStringLiteral("key")).str() == items_[size_t(i)].key;
  if (same) {
    for (int i = 0; i < items.size(); ++i) {
      JValue holder = JValue::object({{QStringLiteral("path"), items_[size_t(i)].node->path()}, {QStringLiteral("type"), QStringLiteral("ListItem")}, {QStringLiteral("children"), items.at(i).get(QStringLiteral("children"))}});
      items_[size_t(i)].node->update(holder);
    }
    return;
  }
  beginResetModel();
  for (auto& it : items_) it.node->deleteLater();
  items_.clear();
  const QString base = e.get(QStringLiteral("path")).str();
  for (int i = 0; i < items.size(); ++i) {
    JValue holder = JValue::object({{QStringLiteral("path"), base + QStringLiteral("/items/") + QString::number(i)}, {QStringLiteral("type"), QStringLiteral("ListItem")}, {QStringLiteral("key"), items.at(i).get(QStringLiteral("key"))}, {QStringLiteral("children"), items.at(i).get(QStringLiteral("children"))}});
    items_.push_back({items.at(i).get(QStringLiteral("key")).str(), new SlotItem(holder, owner)});
  }
  endResetModel();
  emit countChanged();
}

InstanceBudget* InstanceBudget::instance() {
  static InstanceBudget* b = new InstanceBudget();
  return b;
}

bool InstanceBudget::acquire(int n) {
  if (live_ + n > limit_) {
    denied_++;
    emit liveChanged();
    return false;
  }
  live_ += n;
  peak_ = std::max(peak_, live_);
  emit liveChanged();
  return true;
}

void InstanceBudget::release(int n) {
  live_ = std::max(0, live_ - n);
  emit liveChanged();
  emit freed();
}

}  // namespace agentos
