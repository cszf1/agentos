#pragma once
// The route tables (native-rpc/1 routes, write routes, registered workspace.forward routes) embedded from
// renderer/routes.json, generated from packages/contracts by scripts/slot-vectors.mjs.
#include "jvalue.hpp"

namespace agentos {
const JValue& routeTables();
bool isNativeRoute(const QString& methodId);
bool isWriteRoute(const QString& methodId);
/** Client-side mirror of parseForwardBody(): only {routeId, params, body}; never url/path/method/header(s)/
 *  principal/socket/userId/executionUid; routeId must be a registered forward route and every path parameter present.
 *  Returns an empty string when acceptable, otherwise the reason. */
QString checkForwardBody(const JValue& body);
/** Expand a forward route's path with params the way forwardPath() does (only for diagnostics/tests). */
QString forwardPathFor(const QString& routeId, const JValue& params, QString* error);
}  // namespace agentos
