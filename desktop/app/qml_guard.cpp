#include "qml_guard.hpp"

#include "app_view.hpp"
#include "canvas_model.hpp"
#include "chart_item.hpp"
#include "ime_guard.hpp"
#include "json_list_model.hpp"
#include "slot_models.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QLibraryInfo>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QQmlEngine>

namespace agentos {

bool QmlUrlGuard::allowed(const QUrl& url) const {
  const QString s = url.scheme();
  if (s == QLatin1String("qrc")) {
    const QString p = url.path();
    return p.startsWith(QLatin1String("/agentos/qml/")) || p.startsWith(QLatin1String("/qt-project.org/")) || p.startsWith(QLatin1String("/qt/qml/"));
  }
  if (s == QLatin1String("file")) {
    // Only Qt's own installed QML modules (Controls style files, plugins' qmldir) — never user or app paths.
    const QString local = url.toLocalFile();
    if (local.contains(QLatin1String(".."))) return false;
    for (const QString& root : moduleRoots)
      if (local.startsWith(root + QLatin1Char('/'))) return true;
    return false;
  }
  return false;
}

QUrl QmlUrlGuard::intercept(const QUrl& url, DataType type) {
  Q_UNUSED(type);
  if (allowed(url)) return url;
  blocked++;
  qWarning("agentos-shell: blocked QML url %s", qPrintable(url.toString().left(200)));
  return QUrl(QStringLiteral("qrc:/agentos/qml/Blocked.qml"));
}

namespace {
class DenyAll : public QNetworkAccessManager {
 public:
  using QNetworkAccessManager::QNetworkAccessManager;

 protected:
  QNetworkReply* createRequest(Operation, const QNetworkRequest& req, QIODevice*) override {
    QNetworkRequest r(req);
    r.setUrl(QUrl(QStringLiteral("invalid:")));
    return QNetworkAccessManager::createRequest(GetOperation, r, nullptr);
  }
};
}  // namespace

QNetworkAccessManager* NoNetworkFactory::create(QObject* parent) { return new DenyAll(parent); }

void prepareQmlEnvironment() {
  qputenv("QML_DISABLE_DISK_CACHE", "1");
  qunsetenv("QML_IMPORT_TRACE");
  qunsetenv("QML_DEBUG_ARGS");
}

void registerShellTypes() {
  static bool done = false;
  if (done) return;
  done = true;
  qmlRegisterType<ChartItem>("AgentOS.Native", 1, 0, "ChartItem");
  qmlRegisterType<ImeGuard>("AgentOS.Native", 1, 0, "ImeGuard");
  qmlRegisterUncreatableType<SlotItem>("AgentOS.Native", 1, 0, "SlotItem", QStringLiteral("data"));
  qmlRegisterUncreatableType<AppViewModel>("AgentOS.Native", 1, 0, "AppViewModel", QStringLiteral("data"));
  qmlRegisterUncreatableType<JsonListModel>("AgentOS.Native", 1, 0, "JsonListModel", QStringLiteral("data"));
  qmlRegisterUncreatableType<CanvasModel>("AgentOS.Native", 1, 0, "CanvasModel", QStringLiteral("data"));
  qmlRegisterSingletonInstance("AgentOS.Native", 1, 0, "InstanceBudget", InstanceBudget::instance());
}

QmlUrlGuard* hardenEngine(QQmlEngine* engine) {
  prepareQmlEnvironment();
  registerShellTypes();
  auto* guard = new QmlUrlGuard();
  // Keep Qt's configured module directories (QLibraryInfo + the session's QML_IMPORT_PATH set by the trusted
  // launcher/Nix wrapper) but drop the application directory and anything relative or writable-looking.
  QStringList imports;
  const QString appDir = QCoreApplication::applicationDirPath();
  for (const QString& p : engine->importPathList()) {
    if (p.startsWith(QLatin1String("qrc:")) || p.startsWith(QLatin1String(":/"))) {
      imports << p;
      continue;
    }
    if (!QDir::isAbsolutePath(p) || p == appDir || p.startsWith(QDir::homePath()) || p.startsWith(QDir::tempPath())) continue;
    imports << p;
    guard->moduleRoots << QDir(p).canonicalPath() << QDir::cleanPath(p);
  }
  const QString qtQml = QLibraryInfo::path(QLibraryInfo::QmlImportsPath);
  if (!qtQml.isEmpty()) guard->moduleRoots << qtQml;
  engine->setImportPathList(imports);
  engine->addUrlInterceptor(guard);
  engine->setNetworkAccessManagerFactory(new NoNetworkFactory());
  return guard;
}

}  // namespace agentos
