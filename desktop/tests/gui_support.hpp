#pragma once
#include "app_view.hpp"
#include "health_canvas.hpp"
#include "jvalue.hpp"
#include "qml_guard.hpp"
#include "shell_controller.hpp"

#include <QDir>
#include <QFile>
#include <QImage>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickView>
#include <QtTest/QtTest>
#include <functional>

namespace agentos::test {

inline JValue loadFixture(const QString& rel) {
  QFile f(QString::fromUtf8(AGENTOS_FIXTURES) + QLatin1Char('/') + rel);
  if (!f.open(QIODevice::ReadOnly)) qFatal("cannot open %s", qPrintable(f.fileName()));
  return parseJsonOrThrow(f.readAll(), {128, 64 * 1024 * 1024});
}

inline QString outPath(const QString& name) {
  QDir().mkpath(QString::fromUtf8(AGENTOS_TEST_OUT));
  return QString::fromUtf8(AGENTOS_TEST_OUT) + QLatin1Char('/') + name;
}

inline void walkItems(QQuickItem* root, const std::function<void(QQuickItem*)>& f) {
  if (!root) return;
  f(root);
  for (QQuickItem* c : root->childItems()) walkItems(c, f);
}

inline QList<QQuickItem*> itemsOfClass(QQuickItem* root, const char* cls) {
  QList<QQuickItem*> out;
  walkItems(root, [&](QQuickItem* i) {
    if (i->inherits(cls)) out << i;
  });
  return out;
}

inline QQuickItem* findByObjectName(QQuickItem* root, const QString& name) {
  QQuickItem* hit = nullptr;
  walkItems(root, [&](QQuickItem* i) {
    if (!hit && i->objectName() == name) hit = i;
  });
  return hit;
}

inline QString accessibleName(QQuickItem* item) {
  QQmlContext* ctx = qmlContext(item);
  if (!ctx) return {};
  return QQmlProperty(item, QStringLiteral("Accessible.name"), ctx).read().toString();
}

/** True when `item` is visible all the way up (effectively on screen). */
inline bool reallyVisible(QQuickItem* item) {
  for (QQuickItem* i = item; i; i = i->parentItem())
    if (!i->isVisible() || i->opacity() == 0) return false;
  return item->width() > 0 && item->height() > 0;
}

/** A QQuickView on the hardened engine with `shell` in the root context. */
struct View {
  QQuickView view;
  QmlUrlGuard* guard = nullptr;
  explicit View(ShellController* shell, QSize size = {1100, 900}) {
    guard = hardenEngine(view.engine());
    view.engine()->rootContext()->setContextProperty(QStringLiteral("shell"), shell);
    size_ = size;
    view.resize(size);
    view.setColor(Qt::white);
  }
  QSize size_;
  bool load(const QString& qml, const QVariantMap& props = {}) {
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.setInitialProperties(props);
    view.setSource(QUrl(QStringLiteral("qrc:/agentos/qml/") + qml));
    if (view.status() != QQuickView::Ready) {
      for (const auto& e : view.errors()) qWarning() << e.toString();
      return false;
    }
    view.resize(size_);
    view.show();
    return QTest::qWaitForWindowExposed(&view);
  }
  QQuickItem* root() const { return view.rootObject(); }
  QImage shot(const QString& name) {
    QTest::qWait(50);
    QImage img = view.grabWindow();
    img.save(outPath(name));
    return img;
  }
};

}  // namespace agentos::test
