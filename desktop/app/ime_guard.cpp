#include "ime_guard.hpp"

#include <QCoreApplication>
#include <QGuiApplication>
#include <QInputMethod>
#include <QInputMethodEvent>

namespace agentos {

QString ImeGuard::preedit(QQuickItem* item) { return item ? item->property("preeditText").toString() : QString(); }

void ImeGuard::commit(QQuickItem* item) {
  if (!item) return;
  const QString pre = preedit(item);
  if (QGuiApplication::inputMethod()) QGuiApplication::inputMethod()->commit();
  if (pre.isEmpty() || preedit(item).isEmpty()) return;
  QInputMethodEvent ev;
  ev.setCommitString(pre);
  QCoreApplication::sendEvent(item, &ev);
}

void ImeGuard::discard(QQuickItem* item) {
  if (QGuiApplication::inputMethod()) QGuiApplication::inputMethod()->reset();
  if (!item || preedit(item).isEmpty()) return;
  QInputMethodEvent ev(QString(), {});
  QCoreApplication::sendEvent(item, &ev);
}

void ImeGuard::compose(QQuickItem* item, const QString& pre) {
  if (!item) return;
  QList<QInputMethodEvent::Attribute> attrs;
  attrs << QInputMethodEvent::Attribute(QInputMethodEvent::Cursor, int(pre.size()), 1, QVariant());
  QInputMethodEvent ev(pre, attrs);
  QCoreApplication::sendEvent(item, &ev);
}

}  // namespace agentos
