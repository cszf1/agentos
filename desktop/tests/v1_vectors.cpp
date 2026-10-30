#include "../transport/native_rpc.hpp"

#include <fstream>
#include <iostream>
#include <sstream>

static const agentos::J& need(const agentos::J& obj, const char* key) {
  const agentos::J* f = obj.field(key);
  if (!f) throw agentos::JsonError(std::string("missing ") + key);
  return *f;
}

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: v1_vectors <vectors.json>\n";
    return 2;
  }
  std::ifstream in(argv[1]);
  std::stringstream buf;
  buf << in.rdbuf();
  agentos::J root = agentos::parse_json(buf.str());
  for (const agentos::J& item : need(root, "hashes").a) {
    std::string got = agentos::domain_hash(need(item, "domain").s, need(item, "value"));
    if (got != need(item, "hash").s) {
      std::cerr << "hash mismatch " << need(item, "name").s << "\n" << got << "\n";
      return 1;
    }
  }
  for (const agentos::J& item : need(root, "strict").a) {
    bool ok = true;
    try {
      agentos::parse_json(need(item, "text").s);
    } catch (const agentos::JsonError&) {
      ok = false;
    }
    if (ok != need(item, "ok").b) {
      std::cerr << "strict mismatch " << need(item, "name").s << "\n";
      return 1;
    }
  }
  const agentos::J& frame = need(root, "frame");
  auto bytes = agentos::encode_frame(need(frame, "payload").s);
  if (agentos::bytes_hex(bytes.data(), bytes.size()) != need(frame, "hex").s) {
    std::cerr << "frame mismatch\n";
    return 1;
  }
  std::cout << "c++ v1 vectors match\n";
  return 0;
}
