#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace agentos {

struct JsonError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

enum class JKind { Null, Bool, Num, Str, Arr, Obj };

struct J {
  JKind kind = JKind::Null;
  bool b = false;
  long long n = 0;
  std::string s;
  std::vector<J> a;
  std::vector<std::pair<std::string, J>> o;

  const J* field(const std::string& key) const;
};

J parse_json(const std::string& text);
std::string canonical_json(const J& value);
std::string domain_hash(const std::string& domain, const J& value);
std::vector<std::uint8_t> encode_frame(std::string_view payload);
std::string bytes_hex(const std::uint8_t* data, std::size_t n);

}
