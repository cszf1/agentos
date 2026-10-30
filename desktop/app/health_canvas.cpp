#include "health_canvas.hpp"

#include "qml_guard.hpp"

#include <QElapsedTimer>
#include <QGuiApplication>
#include <QImage>
#include <QKeyEvent>
#include <QQmlApplicationEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QSet>
#include <QTimer>
#include <cstdio>

namespace agentos {

bool imageLooksRendered(const QImage& img0, int* distinct, double* ink) {
  if (img0.isNull() || img0.width() < 8 || img0.height() < 8) return false;
  const QImage img = img0.convertToFormat(QImage::Format_RGB32);
  QSet<QRgb> colors;
  const QRgb bg = img.pixel(0, 0);
  qint64 differ = 0, total = 0;
  for (int y = 0; y < img.height(); y += 2)
    for (int x = 0; x < img.width(); x += 2) {
      const QRgb p = img.pixel(x, y);
      if (colors.size() < 4096) colors.insert(p);
      differ += (p != bg) ? 1 : 0;
      total++;
    }
  const double r = total ? double(differ) / double(total) : 0;
  if (distinct) *distinct = int(colors.size());
  if (ink) *ink = r;
  return colors.size() >= 3 && r > 0.005;
}

int runHealthCanvas(QGuiApplication& app, int timeoutMs) {
  QElapsedTimer clock;
  clock.start();
  QQmlApplicationEngine engine;
  hardenEngine(&engine);
  engine.load(QUrl(QStringLiteral("qrc:/agentos/qml/HealthCanvas.qml")));
  auto* win = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().first());
  if (!win) {
    std::fprintf(stdout, "{\"ok\":false,\"error\":\"health canvas did not load\"}\n");
    return 2;
  }
  int rc = 3;
  bool started = false;
  QTimer::singleShot(timeoutMs, &app, [&] {
    std::fprintf(stdout, "{\"ok\":false,\"error\":\"timeout\",\"ms\":%lld}\n", static_cast<long long>(clock.elapsed()));
    app.exit(3);
  });
  QObject::connect(win, &QQuickWindow::frameSwapped, &app, [&] {
    if (started) return;
    started = true;
    QTimer::singleShot(50, &app, [&] {
      auto* input = win->findChild<QQuickItem*>(QStringLiteral("healthInput"));
      if (input) input->forceActiveFocus();
      win->requestActivate();
      for (const QString ch : {QStringLiteral("o"), QStringLiteral("k")}) {
        const int key = ch == QLatin1String("o") ? Qt::Key_O : Qt::Key_K;
        QKeyEvent press(QEvent::KeyPress, key, Qt::NoModifier, ch);
        QKeyEvent release(QEvent::KeyRelease, key, Qt::NoModifier, ch);
        QGuiApplication::sendEvent(win, &press);
        QGuiApplication::sendEvent(win, &release);
      }
      QTimer::singleShot(100, &app, [&, input] {
        const bool typed = input && input->property("text").toString() == QLatin1String("ok");
        const QImage frame = win->grabWindow();
        int colors = 0;
        double inkRatio = 0;
        const bool rendered = imageLooksRendered(frame, &colors, &inkRatio);
        std::fprintf(stdout, "{\"ok\":%s,\"frame\":%s,\"input\":%s,\"width\":%d,\"height\":%d,\"colors\":%d,\"ms\":%lld}\n", (typed && rendered) ? "true" : "false",
                     rendered ? "true" : "false", typed ? "true" : "false", frame.width(), frame.height(), colors, static_cast<long long>(clock.elapsed()));
        std::fflush(stdout);
        rc = (typed && rendered) ? 0 : 1;
        app.exit(rc);
      });
    });
  });
  return app.exec();
}

}  // namespace agentos
