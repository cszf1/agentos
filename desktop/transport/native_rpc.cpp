#include "native_rpc.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace agentos {
namespace {

constexpr std::size_t kMaxFrame = 4 * 1024 * 1024;

void skip(const std::string& t, std::size_t& i) {
  while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) i++;
}

J parse_value(const std::string& t, std::size_t& i, int depth);

std::string parse_string(const std::string& t, std::size_t& i) {
  if (t[i] != '"') throw JsonError("string");
  i++;
  std::string out;
  while (i < t.size()) {
    unsigned char c = static_cast<unsigned char>(t[i++]);
    if (c == '"') return out;
    if (c == '\\') {
      if (i >= t.size()) throw JsonError("escape");
      char e = t[i++];
      if (e == '"' || e == '\\' || e == '/') out.push_back(e);
      else if (e == 'b') out.push_back('\b');
      else if (e == 'f') out.push_back('\f');
      else if (e == 'n') out.push_back('\n');
      else if (e == 'r') out.push_back('\r');
      else if (e == 't') out.push_back('\t');
      else if (e == 'u') {
        if (i + 4 > t.size()) throw JsonError("unicode");
        int n = 0;
        for (int k = 0; k < 4; k++) {
          char h = t[i++];
          n <<= 4;
          if (h >= '0' && h <= '9') n += h - '0';
          else if (h >= 'a' && h <= 'f') n += h - 'a' + 10;
          else if (h >= 'A' && h <= 'F') n += h - 'A' + 10;
          else throw JsonError("unicode");
        }
        out.push_back(static_cast<char>(n));
        if (n > 0x7f) throw JsonError("unicode out of this parser");
      } else throw JsonError("escape");
      continue;
    }
    if (c < 0x20) throw JsonError("control");
    if (c < 0x80) {
      out.push_back(static_cast<char>(c));
      continue;
    }
    int width = c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    if (i - 1 + static_cast<std::size_t>(width) > t.size()) throw JsonError("utf8");
    out.append(t, i - 1, static_cast<std::size_t>(width));
    i += static_cast<std::size_t>(width - 1);
  }
  throw JsonError("unterminated");
}

J parse_number(const std::string& t, std::size_t& i) {
  std::size_t start = i;
  if (t[i] == '-') i++;
  if (i < t.size() && t[i] == '0') i++;
  else if (i < t.size() && t[i] >= '1' && t[i] <= '9') {
    while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
  } else throw JsonError("number");
  bool flt = false;
  if (i < t.size() && t[i] == '.') {
    flt = true;
    i++;
    if (i >= t.size() || t[i] < '0' || t[i] > '9') throw JsonError("number");
    while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
  }
  if (i < t.size() && (t[i] == 'e' || t[i] == 'E')) {
    flt = true;
    i++;
    if (i < t.size() && (t[i] == '+' || t[i] == '-')) i++;
    if (i >= t.size() || t[i] < '0' || t[i] > '9') throw JsonError("number");
    while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
  }
  if (flt) {
    try {
      double n = std::stod(t.substr(start, i - start));
      if (!std::isfinite(n)) throw JsonError("non-finite number");
    } catch (const JsonError&) {
      throw;
    } catch (...) {
      throw JsonError("non-finite number");
    }
    throw JsonError("protocol numbers are integers");
  }
  J v;
  v.kind = JKind::Num;
  v.n = std::stoll(t.substr(start, i - start));
  return v;
}

J parse_value(const std::string& t, std::size_t& i, int depth) {
  if (depth > 32) throw JsonError("nesting too deep");
  skip(t, i);
  if (i >= t.size()) throw JsonError("end");
  char c = t[i];
  if (c == '{') {
    i++;
    J v;
    v.kind = JKind::Obj;
    skip(t, i);
    if (i < t.size() && t[i] == '}') {
      i++;
      return v;
    }
    while (true) {
      skip(t, i);
      std::string key = parse_string(t, i);
      for (const auto& kv : v.o)
        if (kv.first == key) throw JsonError("duplicate key");
      skip(t, i);
      if (i >= t.size() || t[i] != ':') throw JsonError("colon");
      i++;
      v.o.emplace_back(key, parse_value(t, i, depth + 1));
      skip(t, i);
      if (i < t.size() && t[i] == ',') {
        i++;
        continue;
      }
      if (i < t.size() && t[i] == '}') {
        i++;
        return v;
      }
      throw JsonError("object");
    }
  }
  if (c == '[') {
    i++;
    J v;
    v.kind = JKind::Arr;
    skip(t, i);
    if (i < t.size() && t[i] == ']') {
      i++;
      return v;
    }
    while (true) {
      v.a.push_back(parse_value(t, i, depth + 1));
      skip(t, i);
      if (i < t.size() && t[i] == ',') {
        i++;
        continue;
      }
      if (i < t.size() && t[i] == ']') {
        i++;
        return v;
      }
      throw JsonError("array");
    }
  }
  if (c == '"') {
    J v;
    v.kind = JKind::Str;
    v.s = parse_string(t, i);
    return v;
  }
  if (t.compare(i, 4, "true") == 0) {
    i += 4;
    J v;
    v.kind = JKind::Bool;
    v.b = true;
    return v;
  }
  if (t.compare(i, 5, "false") == 0) {
    i += 5;
    J v;
    v.kind = JKind::Bool;
    return v;
  }
  if (t.compare(i, 4, "null") == 0) {
    i += 4;
    return J{};
  }
  if (c == '-' || (c >= '0' && c <= '9')) return parse_number(t, i);
  throw JsonError("value");
}

std::u16string utf16(const std::string& s) {
  std::u16string o;
  const auto* b = reinterpret_cast<const unsigned char*>(s.data());
  std::size_t i = 0;
  while (i < s.size()) {
    uint32_t cp;
    if (b[i] < 0x80) cp = b[i++];
    else if ((b[i] & 0xe0) == 0xc0) {
      cp = ((b[i] & 0x1f) << 6) | (b[i + 1] & 0x3f);
      i += 2;
    } else if ((b[i] & 0xf0) == 0xe0) {
      cp = ((b[i] & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      i += 3;
    } else {
      cp = ((b[i] & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      i += 4;
    }
    if (cp < 0x10000) o.push_back(static_cast<char16_t>(cp));
    else {
      cp -= 0x10000;
      o.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      o.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3ff)));
    }
  }
  return o;
}

void write_string(const std::string& s, std::string& out) {
  out.push_back('"');
  const auto* b = reinterpret_cast<const unsigned char*>(s.data());
  for (std::size_t i = 0; i < s.size();) {
    unsigned char c = b[i];
    if (c < 0x80) {
      if (c == '"') out += "\\\"";
      else if (c == '\\') out += "\\\\";
      else if (c == '\b') out += "\\b";
      else if (c == '\f') out += "\\f";
      else if (c == '\n') out += "\\n";
      else if (c == '\r') out += "\\r";
      else if (c == '\t') out += "\\t";
      else if (c < 0x20) {
        const char* hex = "0123456789abcdef";
        out += "\\u00";
        out.push_back(hex[c >> 4]);
        out.push_back(hex[c & 0xf]);
      } else out.push_back(static_cast<char>(c));
      i++;
    } else {
      int width = c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
      out.append(s, i, static_cast<std::size_t>(width));
      i += static_cast<std::size_t>(width);
    }
  }
  out.push_back('"');
}

void write_value(const J& v, std::string& out) {
  switch (v.kind) {
    case JKind::Null: out += "null"; break;
    case JKind::Bool: out += v.b ? "true" : "false"; break;
    case JKind::Num: out += std::to_string(v.n); break;
    case JKind::Str: write_string(v.s, out); break;
    case JKind::Arr: {
      out.push_back('[');
      for (std::size_t i = 0; i < v.a.size(); i++) {
        if (i) out.push_back(',');
        write_value(v.a[i], out);
      }
      out.push_back(']');
      break;
    }
    case JKind::Obj: {
      std::vector<std::size_t> idx(v.o.size());
      for (std::size_t i = 0; i < idx.size(); i++) idx[i] = i;
      std::sort(idx.begin(), idx.end(), [&](std::size_t a, std::size_t b) { return utf16(v.o[a].first) < utf16(v.o[b].first); });
      out.push_back('{');
      for (std::size_t n = 0; n < idx.size(); n++) {
        if (n) out.push_back(',');
        write_string(v.o[idx[n]].first, out);
        out.push_back(':');
        write_value(v.o[idx[n]].second, out);
      }
      out.push_back('}');
      break;
    }
  }
}

void sha256(const uint8_t* data, std::size_t len, uint8_t out[32]) {
  static const uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  std::vector<uint8_t> msg(data, data + len);
  uint64_t bits = static_cast<uint64_t>(len) * 8;
  msg.push_back(0x80);
  while ((msg.size() % 64) != 56) msg.push_back(0);
  for (int s = 7; s >= 0; s--) msg.push_back(static_cast<uint8_t>((bits >> (s * 8)) & 0xff));
  for (std::size_t off = 0; off < msg.size(); off += 64) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
      w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = (w[i - 15] >> 7 | w[i - 15] << 25) ^ (w[i - 15] >> 18 | w[i - 15] << 14) ^ (w[i - 15] >> 3);
      uint32_t s1 = (w[i - 2] >> 17 | w[i - 2] << 15) ^ (w[i - 2] >> 19 | w[i - 2] << 13) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = (e >> 6 | e << 26) ^ (e >> 11 | e << 21) ^ (e >> 25 | e << 7);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = h + S1 + ch + k[i] + w[i];
      uint32_t S0 = (a >> 2 | a << 30) ^ (a >> 13 | a << 19) ^ (a >> 22 | a << 10);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e; h5 += f; h6 += g; h7 += h;
  }
  uint32_t hs[8] = {h0, h1, h2, h3, h4, h5, h6, h7};
  for (int i = 0; i < 8; i++) {
    out[i * 4] = hs[i] >> 24;
    out[i * 4 + 1] = hs[i] >> 16;
    out[i * 4 + 2] = hs[i] >> 8;
    out[i * 4 + 3] = hs[i];
  }
}

}

const J* J::field(const std::string& key) const {
  for (const auto& kv : o)
    if (kv.first == key) return &kv.second;
  return nullptr;
}

J parse_json(const std::string& text) {
  std::size_t i = 0;
  J v = parse_value(text, i, 0);
  skip(text, i);
  if (i != text.size()) throw JsonError("trailing data");
  return v;
}

std::string canonical_json(const J& value) {
  std::string out;
  write_value(value, out);
  return out;
}

std::string domain_hash(const std::string& domain, const J& value) {
  std::string body = domain;
  body.push_back('\n');
  body += canonical_json(value);
  uint8_t dig[32];
  sha256(reinterpret_cast<const uint8_t*>(body.data()), body.size(), dig);
  return "sha256:" + bytes_hex(dig, 32);
}

std::vector<std::uint8_t> encode_frame(std::string_view payload) {
  if (payload.size() > kMaxFrame) throw JsonError("frame too large");
  std::vector<std::uint8_t> out(4 + payload.size());
  uint32_t n = static_cast<uint32_t>(payload.size());
  out[0] = n >> 24;
  out[1] = n >> 16;
  out[2] = n >> 8;
  out[3] = n;
  std::memcpy(out.data() + 4, payload.data(), payload.size());
  return out;
}

std::string bytes_hex(const std::uint8_t* data, std::size_t n) {
  static const char* hex = "0123456789abcdef";
  std::string o(n * 2, '0');
  for (std::size_t i = 0; i < n; i++) {
    o[i * 2] = hex[data[i] >> 4];
    o[i * 2 + 1] = hex[data[i] & 0xf];
  }
  return o;
}

}
