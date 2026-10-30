#pragma once
// native-rpc/1 framing (spec §9.2): 4-byte big-endian length + UTF-8 JSON, at most 4 MiB per frame.
#include <QByteArray>

namespace agentos {
constexpr qsizetype kMaxFrameBytes = 4 * 1024 * 1024;
constexpr int kMaxInflight = 32;

QByteArray encodeFrame(const QByteArray& payload);  // empty on oversize

class FrameDecoder {
 public:
  enum class Status { Frame, NeedMore, TooLarge };
  void feed(const QByteArray& bytes) { buf_.append(bytes); }
  Status next(QByteArray* payload);
  qsizetype buffered() const { return buf_.size(); }
  void reset() { buf_.clear(); }

 private:
  QByteArray buf_;
};
}  // namespace agentos
