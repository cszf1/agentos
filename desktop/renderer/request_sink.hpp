#pragma once
#include "rpc_client.hpp"
#include "slot_runtime.hpp"

#include <functional>

namespace agentos {
/** What an app view needs from the Shell: a scoped request channel and the trusted confirmation layer. */
class RequestSink {
 public:
  virtual ~RequestSink() = default;
  virtual void sendForward(const ForwardRequest& r, std::function<void(const RpcReply&)> done) = 0;
  virtual void openSystemPlan(const QString& actionId) = 0;
  virtual void askAppConfirm(const QString& appTitle, const QString& text, std::function<void(bool)> done) = 0;
  virtual void reportError(const QString& code) = 0;
  /** false when the Host is unavailable (read-only cache), or for system actions when the broker is down. */
  virtual bool canWrite(bool systemAction) const = 0;
};
}  // namespace agentos
