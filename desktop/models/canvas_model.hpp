#pragma once
// Home canvas layout (spec §11): cards hold only appId, position, size and versioned UI prefs — never app content
// or grants. At most 4 cards are expanded at once; expanding/focusing never triggers a model call.
#include "jvalue.hpp"

#include <QAbstractListModel>

namespace agentos {

class CanvasModel : public QAbstractListModel {
  Q_OBJECT
  Q_PROPERTY(int count READ count NOTIFY countChanged)
  Q_PROPERTY(int expandedCount READ expandedCount NOTIFY layoutChanged2)
 public:
  static constexpr int kMaxExpanded = 4;
  static constexpr int kPrefsVersion = 1;
  enum Roles { AppIdRole = Qt::UserRole + 1, XRole, YRole, WRole, HRole, ExpandedRole, PinnedRole, TitleRole, ViewRole };
  struct Card {
    QString appId;
    int x = 0, y = 0, w = 1, h = 1;
    bool expanded = false, pinned = false;
    qint64 expandedAt = 0;
  };
  using QAbstractListModel::QAbstractListModel;
  int rowCount(const QModelIndex& p = {}) const override { return p.isValid() ? 0 : int(cards_.size()); }
  QVariant data(const QModelIndex& i, int role) const override;
  QHash<int, QByteArray> roleNames() const override;
  int count() const { return int(cards_.size()); }
  int expandedCount() const;

  /** Apps currently in the workspace (appId -> title). Cards for unknown apps are kept only when pinned. */
  void setApps(const QList<QPair<QString, QString>>& apps);
  void setViewProvider(std::function<QObject*(const QString&)> f) { views_ = std::move(f); }
  Q_INVOKABLE bool setExpanded(const QString& appId, bool on);
  Q_INVOKABLE void setPinned(const QString& appId, bool on);
  Q_INVOKABLE void move(const QString& appId, int x, int y);
  Q_INVOKABLE void resize(const QString& appId, int w, int h);
  Q_INVOKABLE void arrange();
  JValue toJson() const;
  bool fromJson(const JValue& v);
  bool load(const QString& file);
  bool save(const QString& file) const;
  void clear();
  const std::vector<Card>& cards() const { return cards_; }

 signals:
  void countChanged();
  void layoutChanged2();
  void limitReached();

 private:
  std::vector<Card> cards_;
  QMap<QString, QString> titles_;
  std::function<QObject*(const QString&)> views_;
  qint64 clock_ = 0;
  int indexOf(const QString& appId) const;
  void changed(int row);
};

}  // namespace agentos
