// agentos-shell-e2e, phase "sway" (VM check m20-sway; review F12, V1-D02…D07, D09, D11, D12): the same Shell
// (ShellController + fixed QML) as a real Wayland client in alice's greetd/ReGreet Sway session, fullscreen on the
// virtio-gpu output. Every user step is real input: the e2e never presses a button itself, it asks the VM driver
// (E2E-ASK handshake) to move the USB tablet / type on the keyboard through QMP at the item's position, then checks
// what the click or the keys did — in the Shell's models, in what Sway scanned out (screenshot pixels compared with
// the window's own frame) and, through the driver, in the Host's database.
//
//   E2E-ASK <n> <json>   one request to the driver (kind: click | dblclick | type | keys | wheel | shot | do)
//   <dir>/ack-<n>        the driver's answer (JSON); the e2e waits for it, normally running its event loop, or with
//                        the UI thread blocked when it plays a slow reader (V1-D09)
#pragma once
#include "gui_support.hpp"
#include "json_list_model.hpp"

#include <QClipboard>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QProcess>
#include <QScreen>
#include <QThread>
#include <cstdio>

namespace agentos::test {

/** Counts a QML button's clicked() signal: proof that the real pointer press reached that very control. */
class ClickCounter : public QObject {
  Q_OBJECT
 public:
  int n = 0;
 public slots:
  void hit() { ++n; }
};

struct Asker {
  QString dir;
  int n = 0;
  explicit Asker(QString d) : dir(std::move(d)) {}
  JValue ask(const QString& kind, QVariantMap args = {}, int ms = 240000, bool block = false) {
    const int id = ++n;
    args.insert(QStringLiteral("kind"), kind);
    std::printf("E2E-ASK %d %s\n", id, JValue::fromVariant(args).stringify().toUtf8().constData());
    std::fflush(stdout);
    const QString f = dir + QStringLiteral("/ack-") + QString::number(id);
    QElapsedTimer t;
    t.start();
    while (!QFile::exists(f) && t.elapsed() < ms) {
      if (block)
        QThread::msleep(100);  // the UI thread does not run: events pile up in the transport worker (bounded)
      else
        QTest::qWait(100);
    }
    QFile a(f);
    if (!a.open(QIODevice::ReadOnly)) {
      std::printf("E2E-DIAG ask %d %s: no answer within %d ms\n", id, qPrintable(kind), ms);
      std::fflush(stdout);
      return JValue();
    }
    const QByteArray b = a.readAll().trimmed();
    if (b.isEmpty()) return JValue::object();
    try {
      return parseJsonOrThrow(b);
    } catch (...) {
      return JValue::object({{QStringLiteral("raw"), QString::fromUtf8(b)}});
    }
  }
};

inline QPointF centerOf(QQuickItem* i) { return i->mapToScene(QPointF(i->width() / 2, i->height() / 2)); }

}  // namespace agentos::test
