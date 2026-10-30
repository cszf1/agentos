#pragma once
// Uncommitted IME composition (preedit, e.g. Fcitx5 pinyin) handling (spec §10.3, V1-D10):
//  - switching field: the composition is committed into the field it belongs to (it never jumps fields);
//  - switching workspace / lock / logout: the composition is discarded, never committed into the next scope.
#include <QObject>
#include <QQuickItem>

namespace agentos {

class ImeGuard : public QObject {
  Q_OBJECT
 public:
  using QObject::QObject;
  Q_INVOKABLE static QString preedit(QQuickItem* item);
  Q_INVOKABLE static void commit(QQuickItem* item);
  Q_INVOKABLE static void discard(QQuickItem* item);
  /** Test helper: inject a composition as an input method would. */
  Q_INVOKABLE static void compose(QQuickItem* item, const QString& preedit);
};

}  // namespace agentos
