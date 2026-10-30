#include "canvas_model.hpp"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSaveFile>

namespace agentos {

QHash<int, QByteArray> CanvasModel::roleNames() const {
  return {{AppIdRole, "appId"}, {XRole, "cx"}, {YRole, "cy"}, {WRole, "cw"}, {HRole, "ch"}, {ExpandedRole, "expanded"}, {PinnedRole, "pinned"}, {TitleRole, "title"}, {ViewRole, "view"}};
}

QVariant CanvasModel::data(const QModelIndex& i, int role) const {
  if (!i.isValid() || i.row() >= int(cards_.size())) return {};
  const Card& c = cards_[size_t(i.row())];
  switch (role) {
    case AppIdRole: return c.appId;
    case XRole: return c.x;
    case YRole: return c.y;
    case WRole: return c.w;
    case HRole: return c.h;
    case ExpandedRole: return c.expanded;
    case PinnedRole: return c.pinned;
    case TitleRole: return titles_.value(c.appId, c.appId);
    case ViewRole: return QVariant::fromValue<QObject*>(views_ && c.expanded ? views_(c.appId) : nullptr);
  }
  return {};
}

int CanvasModel::indexOf(const QString& appId) const {
  for (size_t i = 0; i < cards_.size(); ++i)
    if (cards_[i].appId == appId) return int(i);
  return -1;
}

int CanvasModel::expandedCount() const {
  int n = 0;
  for (const auto& c : cards_) n += c.expanded ? 1 : 0;
  return n;
}

void CanvasModel::changed(int row) {
  emit dataChanged(index(row), index(row));
  emit layoutChanged2();
}

void CanvasModel::setApps(const QList<QPair<QString, QString>>& apps) {
  beginResetModel();
  titles_.clear();
  QSet<QString> present;
  for (const auto& a : apps) {
    titles_[a.first] = a.second;
    present.insert(a.first);
  }
  std::vector<Card> kept;
  for (const auto& c : cards_)
    if (present.contains(c.appId) || c.pinned) kept.push_back(c);
  cards_ = kept;
  int y = 0;
  for (const auto& c : cards_) y = std::max(y, c.y + c.h);
  for (const auto& a : apps)
    if (indexOf(a.first) < 0) {
      Card c;
      c.appId = a.first;
      c.x = int(cards_.size() % 3);
      c.y = y + int(cards_.size() / 3);
      cards_.push_back(c);
    }
  endResetModel();
  emit countChanged();
  emit layoutChanged2();
}

bool CanvasModel::setExpanded(const QString& appId, bool on) {
  int i = indexOf(appId);
  if (i < 0) return false;
  if (on && !cards_[size_t(i)].expanded && expandedCount() >= kMaxExpanded) {
    emit limitReached();
    return false;
  }
  cards_[size_t(i)].expanded = on;
  cards_[size_t(i)].expandedAt = on ? ++clock_ : 0;
  changed(i);
  return true;
}
void CanvasModel::setPinned(const QString& appId, bool on) {
  int i = indexOf(appId);
  if (i < 0) return;
  cards_[size_t(i)].pinned = on;
  changed(i);
}
void CanvasModel::move(const QString& appId, int x, int y) {
  int i = indexOf(appId);
  if (i < 0) return;
  cards_[size_t(i)].x = std::clamp(x, 0, 64);
  cards_[size_t(i)].y = std::clamp(y, 0, 256);
  changed(i);
}
void CanvasModel::resize(const QString& appId, int w, int h) {
  int i = indexOf(appId);
  if (i < 0) return;
  cards_[size_t(i)].w = std::clamp(w, 1, 4);
  cards_[size_t(i)].h = std::clamp(h, 1, 4);
  changed(i);
}
void CanvasModel::arrange() {
  beginResetModel();
  std::stable_sort(cards_.begin(), cards_.end(), [](const Card& a, const Card& b) { return a.pinned > b.pinned; });
  for (size_t i = 0; i < cards_.size(); ++i) {
    cards_[i].x = int(i % 3);
    cards_[i].y = int(i / 3);
  }
  endResetModel();
  emit layoutChanged2();
}

JValue CanvasModel::toJson() const {
  JValue cards = JValue::array();
  for (const auto& c : cards_) {
    cards.push(JValue::object({{QStringLiteral("appId"), c.appId},
                               {QStringLiteral("x"), c.x},
                               {QStringLiteral("y"), c.y},
                               {QStringLiteral("w"), c.w},
                               {QStringLiteral("h"), c.h},
                               {QStringLiteral("prefs"), JValue::object({{QStringLiteral("expanded"), c.expanded}, {QStringLiteral("pinned"), c.pinned}})}}));
  }
  return JValue::object({{QStringLiteral("prefsVersion"), kPrefsVersion}, {QStringLiteral("cards"), cards}});
}

bool CanvasModel::fromJson(const JValue& v) {
  static const QRegularExpression id(QStringLiteral("^[A-Za-z0-9_\\-.]{1,128}$"));
  if (!v.isObject() || v.get(QStringLiteral("prefsVersion")).toNumber() != kPrefsVersion) return false;
  std::vector<Card> cards;
  int expanded = 0;
  for (const auto& c : v.get(QStringLiteral("cards")).items()) {
    const QString appId = c.get(QStringLiteral("appId")).stringOr(QString());
    if (!id.match(appId).hasMatch() || cards.size() >= 64) continue;
    Card k;
    k.appId = appId;
    k.x = std::clamp(int(c.get(QStringLiteral("x")).toNumber()), 0, 64);
    k.y = std::clamp(int(c.get(QStringLiteral("y")).toNumber()), 0, 256);
    k.w = std::clamp(int(c.get(QStringLiteral("w")).toNumber()), 1, 4);
    k.h = std::clamp(int(c.get(QStringLiteral("h")).toNumber()), 1, 4);
    const JValue& p = c.get(QStringLiteral("prefs"));
    k.expanded = p.get(QStringLiteral("expanded")).toBool() && expanded < kMaxExpanded;
    expanded += k.expanded ? 1 : 0;
    k.pinned = p.get(QStringLiteral("pinned")).toBool();
    cards.push_back(k);
  }
  beginResetModel();
  cards_ = cards;
  endResetModel();
  emit countChanged();
  emit layoutChanged2();
  return true;
}

bool CanvasModel::load(const QString& file) {
  QFile f(file);
  if (!f.open(QIODevice::ReadOnly) || f.size() > 256 * 1024) return false;
  QString err;
  JValue v = parseJson(f.readAll(), &err);
  return err.isEmpty() && fromJson(v);
}

bool CanvasModel::save(const QString& file) const {
  QDir().mkpath(QFileInfo(file).absolutePath());
  QSaveFile f(file);
  if (!f.open(QIODevice::WriteOnly)) return false;
  f.write(toJson().toJsonUtf8());
  return f.commit();
}

void CanvasModel::clear() {
  beginResetModel();
  cards_.clear();
  titles_.clear();
  endResetModel();
  emit countChanged();
}

}  // namespace agentos
