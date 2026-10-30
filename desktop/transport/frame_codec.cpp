#include "frame_codec.hpp"

namespace agentos {

QByteArray encodeFrame(const QByteArray& payload) {
  if (payload.size() > kMaxFrameBytes) return {};
  QByteArray out;
  out.reserve(payload.size() + 4);
  const quint32 n = quint32(payload.size());
  out.append(char((n >> 24) & 0xFF));
  out.append(char((n >> 16) & 0xFF));
  out.append(char((n >> 8) & 0xFF));
  out.append(char(n & 0xFF));
  out.append(payload);
  return out;
}

FrameDecoder::Status FrameDecoder::next(QByteArray* payload) {
  if (buf_.size() < 4) return Status::NeedMore;
  const auto* d = reinterpret_cast<const uchar*>(buf_.constData());
  const quint32 n = (quint32(d[0]) << 24) | (quint32(d[1]) << 16) | (quint32(d[2]) << 8) | quint32(d[3]);
  if (n > quint32(kMaxFrameBytes)) return Status::TooLarge;
  if (buf_.size() < qsizetype(4 + n)) return Status::NeedMore;
  *payload = buf_.mid(4, n);
  buf_.remove(0, 4 + n);
  return Status::Frame;
}

}  // namespace agentos
