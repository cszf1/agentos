#pragma once
// QML engine hardening (spec §10.1): only the fixed qrc:/agentos/qml resources and Qt's own installed modules load;
// no network, no file:/http:/data: URLs, no QML/JS from data.
#include <QQmlAbstractUrlInterceptor>
#include <QQmlEngine>
#include <QQmlNetworkAccessManagerFactory>

namespace agentos {

class QmlUrlGuard : public QQmlAbstractUrlInterceptor {
 public:
  QUrl intercept(const QUrl& url, DataType type) override;
  bool allowed(const QUrl& url) const;
  /** Directories holding Qt's own QML modules (from Qt's configuration / the trusted session environment). */
  QStringList moduleRoots;
  int blocked = 0;
};

class NoNetworkFactory : public QQmlNetworkAccessManagerFactory {
 public:
  QNetworkAccessManager* create(QObject* parent) override;
};

/** Register C++ types and lock the engine down. Returns the guard (owned by the engine's lifetime). */
QmlUrlGuard* hardenEngine(QQmlEngine* engine);
void registerShellTypes();
/** Must run before any QQmlEngine exists: no on-disk QML cache (a writable cache in $HOME would let foreign
 *  compiled code run), no QML debugger/profiler connectors. */
void prepareQmlEnvironment();

}  // namespace agentos
