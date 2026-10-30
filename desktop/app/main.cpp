// agentos-shell: the native Qt 6 Shell of AgentOS v1.0 (spec §10, §11). No browser engine: Qt Quick only.
#include "health_canvas.hpp"
#include "qml_guard.hpp"
#include "rpc_client.hpp"
#include "shell_controller.hpp"

#include <QElapsedTimer>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTimer>
#include <cstdio>

int main(int argc, char** argv) {
  QElapsedTimer startup;
  startup.start();
  agentos::prepareQmlEnvironment();
  QQuickStyle::setStyle(QStringLiteral("Basic"));
  QGuiApplication app(argc, argv);
  QGuiApplication::setApplicationName(QStringLiteral("agentos-shell"));
  QGuiApplication::setOrganizationName(QStringLiteral("AgentOS"));
  const QStringList args = app.arguments();
  if (args.contains(QStringLiteral("--version"))) {
    std::printf("agentos-shell 1.0.0 (native-rpc/1, Qt %s)\n", qVersion());
    return 0;
  }
  if (args.contains(QStringLiteral("--health-canvas"))) return agentos::runHealthCanvas(app, 20000);

  agentos::ShellController shell(agentos::RpcClient::defaultSocketPath());
  QQmlApplicationEngine engine;
  agentos::hardenEngine(&engine);
  engine.rootContext()->setContextProperty(QStringLiteral("shell"), &shell);
  engine.load(QUrl(QStringLiteral("qrc:/agentos/qml/Main.qml")));
  if (engine.rootObjects().isEmpty()) return 2;
  auto* win = qobject_cast<QQuickWindow*>(engine.rootObjects().first());
  // The first visible frame comes before any gateway round trip (spec V1-D11: visible state within 5 s of a restart).
  if (args.contains(QStringLiteral("--first-frame-probe")) && win) {
    QObject::connect(win, &QQuickWindow::frameSwapped, &app, [&] {
      std::printf("{\"firstFrameMs\":%lld}\n", static_cast<long long>(startup.elapsed()));
      std::fflush(stdout);
      app.exit(startup.elapsed() <= 5000 ? 0 : 1);
    }, Qt::SingleShotConnection);
    QTimer::singleShot(10000, &app, [&] { app.exit(4); });
  }
  shell.start();
  return app.exec();
}
