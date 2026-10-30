#include "routes.hpp"

#include <QFile>
#include <QRegularExpression>

namespace agentos {

const JValue& routeTables() {
  static const JValue t = [] {
    QFile f(QStringLiteral(":/agentos/renderer/routes.json"));
    if (!f.open(QIODevice::ReadOnly)) qFatal("routes.json missing from resources");
    return parseJsonOrThrow(f.readAll());
  }();
  return t;
}

bool isNativeRoute(const QString& m) {
  for (const auto& r : routeTables().get(QStringLiteral("native")).items())
    if (r.str() == m) return true;
  return false;
}
bool isWriteRoute(const QString& m) {
  for (const auto& r : routeTables().get(QStringLiteral("writeRoutes")).items())
    if (r.str() == m) return true;
  return false;
}

QString forwardPathFor(const QString& routeId, const JValue& params, QString* error) {
  const JValue& r = routeTables().get(QStringLiteral("forward")).get(routeId);
  if (r.isMissing()) {
    if (error) *error = QStringLiteral("routeId is not registered");
    return {};
  }
  static const QRegularExpression ph(QStringLiteral(":(\\w+)"));
  static const QRegularExpression ok(QStringLiteral("^[A-Za-z0-9_\\-.]{1,128}$"));
  QString path = r.get(QStringLiteral("path")).str();
  QStringList used;
  QString out;
  qsizetype last = 0;
  auto it = ph.globalMatch(path);
  while (it.hasNext()) {
    auto m = it.next();
    const QString name = m.captured(1);
    const JValue& v = params.get(name);
    if (!v.isString() || !ok.match(v.str()).hasMatch()) {
      if (error) *error = QStringLiteral("path param %1 is invalid").arg(name);
      return {};
    }
    out += path.mid(last, m.capturedStart() - last) + v.str();
    last = m.capturedEnd();
    used << name;
  }
  out += path.mid(last);
  for (const auto& m : params.members())
    if (!used.contains(m.first)) {
      if (error) *error = QStringLiteral("unknown path param %1").arg(m.first);
      return {};
    }
  return out;
}

QString checkForwardBody(const JValue& body) {
  static const QStringList forbidden = {QStringLiteral("url"), QStringLiteral("path"), QStringLiteral("method"), QStringLiteral("header"), QStringLiteral("headers"),
                                        QStringLiteral("principal"), QStringLiteral("socket"), QStringLiteral("userId"), QStringLiteral("executionUid")};
  if (!body.isObject()) return QStringLiteral("forward body must be an object");
  for (const auto& m : body.members()) {
    if (forbidden.contains(m.first)) return QStringLiteral("forward cannot carry ") + m.first;
    if (m.first != QLatin1String("routeId") && m.first != QLatin1String("params") && m.first != QLatin1String("body")) return QStringLiteral("unknown forward field ") + m.first;
  }
  const JValue& rid = body.get(QStringLiteral("routeId"));
  if (!rid.isString() || rid.str().contains(QLatin1String("://")) || rid.str().startsWith(QLatin1Char('/'))) return QStringLiteral("routeId is not a URL");
  if (!routeTables().get(QStringLiteral("forward")).has(rid.str())) return QStringLiteral("routeId is not registered");
  const JValue& params = body.get(QStringLiteral("params"));
  if (!params.isMissing() && !params.isNull() && !params.isObject()) return QStringLiteral("params must be an object");
  QString err;
  forwardPathFor(rid.str(), params.isObject() ? params : JValue::object(), &err);
  return err;
}

}  // namespace agentos

