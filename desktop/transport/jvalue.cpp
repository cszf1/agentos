#include "jvalue.hpp"

#include <QRegularExpression>
#include <charconv>
#include <cmath>
#include <stdexcept>

namespace agentos {

static const JValue kMissing;
static const JArray kEmptyArray;
static const JObject kEmptyObject;

JValue JValue::null() {
  JValue v;
  v.kind_ = Kind::Null;
  return v;
}
JValue::JValue(bool v) : kind_(Kind::Bool), b_(v) {}
JValue::JValue(double v) : kind_(Kind::Number), n_(v) {}
JValue::JValue(const QString& v) : kind_(Kind::String), s_(v) {}
JValue JValue::array(JArray items) {
  JValue v;
  v.kind_ = Kind::Array;
  v.a_ = std::make_shared<JArray>(std::move(items));
  return v;
}
JValue JValue::object(JObject members) {
  JValue v;
  v.kind_ = Kind::Object;
  v.o_ = std::make_shared<JObject>(std::move(members));
  return v;
}

bool JValue::isSafeInteger() const {
  return kind_ == Kind::Number && std::isfinite(n_) && std::floor(n_) == n_ && std::fabs(n_) <= 9007199254740991.0;
}

void JValue::detach() {
  if (a_ && a_.use_count() > 1) a_ = std::make_shared<JArray>(*a_);
  if (o_ && o_.use_count() > 1) o_ = std::make_shared<JObject>(*o_);
}

int JValue::size() const {
  if (kind_ == Kind::Array) return int(a_->size());
  if (kind_ == Kind::Object) return int(o_->size());
  return 0;
}
const JValue& JValue::at(int i) const {
  if (kind_ != Kind::Array || i < 0 || i >= int(a_->size())) return kMissing;
  return (*a_)[size_t(i)];
}
const JArray& JValue::items() const { return kind_ == Kind::Array ? *a_ : kEmptyArray; }
void JValue::push(const JValue& v) {
  if (kind_ != Kind::Array) {
    *this = array();
  }
  detach();
  a_->push_back(v);
}
const JValue* JValue::find(const QString& key) const {
  if (kind_ != Kind::Object) return nullptr;
  for (const auto& m : *o_)
    if (m.first == key) return &m.second;
  return nullptr;
}
const JValue& JValue::get(const QString& key) const {
  const JValue* f = find(key);
  return f ? *f : kMissing;
}
const JObject& JValue::members() const { return kind_ == Kind::Object ? *o_ : kEmptyObject; }
QStringList JValue::keys() const {
  QStringList out;
  for (const auto& m : members()) out << m.first;
  return out;
}
void JValue::set(const QString& key, const JValue& v) {
  if (kind_ != Kind::Object) *this = object();
  detach();
  for (auto& m : *o_)
    if (m.first == key) {
      m.second = v;
      return;
    }
  o_->emplace_back(key, v);
}
void JValue::remove(const QString& key) {
  if (kind_ != Kind::Object) return;
  detach();
  for (auto it = o_->begin(); it != o_->end(); ++it)
    if (it->first == key) {
      o_->erase(it);
      return;
    }
}

bool JValue::strictEquals(const JValue& o) const {
  if (kind_ != o.kind_) return false;
  switch (kind_) {
    case Kind::Missing:
    case Kind::Null: return true;
    case Kind::Bool: return b_ == o.b_;
    case Kind::Number: return n_ == o.n_;
    case Kind::String: return s_ == o.s_;
    case Kind::Array: return a_ == o.a_;
    case Kind::Object: return o_ == o.o_;
  }
  return false;
}

bool JValue::deepEquals(const JValue& o) const {
  if (kind_ != o.kind_) return false;
  if (kind_ == Kind::Array) {
    if (a_->size() != o.a_->size()) return false;
    for (size_t i = 0; i < a_->size(); ++i)
      if (!(*a_)[i].deepEquals((*o.a_)[i])) return false;
    return true;
  }
  if (kind_ == Kind::Object) {
    if (o_->size() != o.o_->size()) return false;
    for (const auto& m : *o_) {
      const JValue* f = o.find(m.first);
      if (!f || !m.second.deepEquals(*f)) return false;
    }
    return true;
  }
  return strictEquals(o);
}

QString jsNumberToString(double d) {
  if (std::isnan(d)) return QStringLiteral("NaN");
  if (std::isinf(d)) return d > 0 ? QStringLiteral("Infinity") : QStringLiteral("-Infinity");
  if (d == 0) return QStringLiteral("0");
  char buf[64];
  auto r = std::to_chars(buf, buf + sizeof buf, d, std::chars_format::scientific);
  std::string sci(buf, r.ptr);
  bool neg = false;
  size_t p = 0;
  if (sci[0] == '-') {
    neg = true;
    p = 1;
  }
  size_t e = sci.find('e');
  std::string mant = sci.substr(p, e - p);
  int exp10 = std::stoi(sci.substr(e + 1));
  std::string digits;
  for (char c : mant)
    if (c != '.') digits += c;
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  int k = int(digits.size());
  int n = exp10 + 1;
  std::string out;
  if (k <= n && n <= 21) {
    out = digits + std::string(size_t(n - k), '0');
  } else if (0 < n && n <= 21) {
    out = digits.substr(0, size_t(n)) + "." + digits.substr(size_t(n));
  } else if (-6 < n && n <= 0) {
    out = "0." + std::string(size_t(-n), '0') + digits;
  } else {
    int ee = n - 1;
    std::string es = (ee >= 0 ? "+" : "-") + std::to_string(std::abs(ee));
    if (k == 1) out = digits + "e" + es;
    else out = digits.substr(0, 1) + "." + digits.substr(1) + "e" + es;
  }
  if (neg) out = "-" + out;
  return QString::fromLatin1(out.c_str());
}

static void quote(QString& out, const QString& s) {
  out += QLatin1Char('"');
  for (int i = 0; i < s.size(); ++i) {
    QChar c = s[i];
    ushort u = c.unicode();
    switch (u) {
      case '"': out += QLatin1String("\\\""); break;
      case '\\': out += QLatin1String("\\\\"); break;
      case '\b': out += QLatin1String("\\b"); break;
      case '\f': out += QLatin1String("\\f"); break;
      case '\n': out += QLatin1String("\\n"); break;
      case '\r': out += QLatin1String("\\r"); break;
      case '\t': out += QLatin1String("\\t"); break;
      default:
        if (u < 0x20) {
          out += QStringLiteral("\\u%1").arg(u, 4, 16, QLatin1Char('0'));
        } else if (c.isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate()) {
          out += c;
          out += s[++i];
        } else if (c.isSurrogate()) {
          out += QStringLiteral("\\u%1").arg(u, 4, 16, QLatin1Char('0'));
        } else {
          out += c;
        }
    }
  }
  out += QLatin1Char('"');
}

static void stringifyInto(QString& out, const JValue& v, bool inArray) {
  switch (v.kind()) {
    case JValue::Kind::Missing: out += inArray ? QStringLiteral("null") : QString(); break;
    case JValue::Kind::Null: out += QStringLiteral("null"); break;
    case JValue::Kind::Bool: out += v.toBool() ? QStringLiteral("true") : QStringLiteral("false"); break;
    case JValue::Kind::Number: out += std::isfinite(v.toNumber()) ? jsNumberToString(v.toNumber()) : QStringLiteral("null"); break;
    case JValue::Kind::String: quote(out, v.str()); break;
    case JValue::Kind::Array: {
      out += QLatin1Char('[');
      bool first = true;
      for (const auto& x : v.items()) {
        if (!first) out += QLatin1Char(',');
        first = false;
        stringifyInto(out, x, true);
      }
      out += QLatin1Char(']');
      break;
    }
    case JValue::Kind::Object: {
      out += QLatin1Char('{');
      bool first = true;
      for (const auto& m : v.members()) {
        if (m.second.isMissing()) continue;
        if (!first) out += QLatin1Char(',');
        first = false;
        quote(out, m.first);
        out += QLatin1Char(':');
        stringifyInto(out, m.second, false);
      }
      out += QLatin1Char('}');
      break;
    }
  }
}

QString JValue::stringify(bool* undefinedOut) const {
  if (undefinedOut) *undefinedOut = isMissing();
  QString out;
  stringifyInto(out, *this, false);
  return out;
}

QVariant JValue::toVariant() const {
  switch (kind_) {
    case Kind::Missing: return QVariant();
    case Kind::Null: return QVariant::fromValue(nullptr);
    case Kind::Bool: return b_;
    case Kind::Number: return n_;
    case Kind::String: return s_;
    case Kind::Array: {
      QVariantList l;
      for (const auto& x : *a_) l << x.toVariant();
      return l;
    }
    case Kind::Object: {
      QVariantMap m;
      for (const auto& x : *o_) m.insert(x.first, x.second.toVariant());
      return m;
    }
  }
  return {};
}

JValue JValue::fromVariant(const QVariant& v) {
  if (!v.isValid()) return JValue();
  switch (v.typeId()) {
    case QMetaType::Nullptr: return JValue::null();
    case QMetaType::Bool: return JValue(v.toBool());
    case QMetaType::Int:
    case QMetaType::LongLong:
    case QMetaType::UInt:
    case QMetaType::ULongLong:
    case QMetaType::Double:
    case QMetaType::Float: return JValue(v.toDouble());
    case QMetaType::QString: return JValue(v.toString());
    case QMetaType::QVariantList:
    case QMetaType::QStringList: {
      JValue a = JValue::array();
      for (const auto& x : v.toList()) a.push(fromVariant(x));
      return a;
    }
    case QMetaType::QVariantMap: {
      JValue o = JValue::object();
      const auto m = v.toMap();
      for (auto it = m.begin(); it != m.end(); ++it) o.set(it.key(), fromVariant(it.value()));
      return o;
    }
    default: return JValue(v.toString());
  }
}

// ---------------------------------------------------------------- strict parser
namespace {
struct Parser {
  const QByteArray& t;
  qsizetype i = 0;
  int maxDepth;
  [[noreturn]] void fail(const char* m) { throw std::runtime_error(m); }
  void ws() {
    while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) i++;
  }
  JValue value(int depth) {
    if (depth > maxDepth) fail("nesting too deep");
    ws();
    if (i >= t.size()) fail("unexpected end");
    char c = t[i];
    if (c == '{') return obj(depth);
    if (c == '[') return arr(depth);
    if (c == '"') return JValue(str());
    if (c == 't') return lit("true", JValue(true));
    if (c == 'f') return lit("false", JValue(false));
    if (c == 'n') return lit("null", JValue::null());
    if (c == '-' || (c >= '0' && c <= '9')) return num();
    fail("invalid JSON");
  }
  JValue lit(const char* w, JValue v) {
    qsizetype n = qsizetype(strlen(w));
    if (t.mid(i, n) != QByteArray(w)) fail("invalid JSON");
    i += n;
    return v;
  }
  JValue obj(int depth) {
    i++;
    JObject members;
    ws();
    if (i < t.size() && t[i] == '}') {
      i++;
      return JValue::object(std::move(members));
    }
    for (;;) {
      ws();
      if (i >= t.size() || t[i] != '"') fail("object key must be a string");
      QString k = str();
      for (const auto& m : members)
        if (m.first == k) fail("duplicate key");
      ws();
      if (i >= t.size() || t[i] != ':') fail("expected colon");
      i++;
      JValue v = value(depth + 1);
      members.emplace_back(k, v);
      ws();
      if (i < t.size() && t[i] == ',') {
        i++;
        continue;
      }
      if (i < t.size() && t[i] == '}') {
        i++;
        return JValue::object(std::move(members));
      }
      fail("expected , or }");
    }
  }
  JValue arr(int depth) {
    i++;
    JArray items;
    ws();
    if (i < t.size() && t[i] == ']') {
      i++;
      return JValue::array(std::move(items));
    }
    for (;;) {
      items.push_back(value(depth + 1));
      ws();
      if (i < t.size() && t[i] == ',') {
        i++;
        continue;
      }
      if (i < t.size() && t[i] == ']') {
        i++;
        return JValue::array(std::move(items));
      }
      fail("expected , or ]");
    }
  }
  static int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  QString str() {
    i++;
    QString out;
    for (;;) {
      if (i >= t.size()) fail("unterminated string");
      unsigned char c = uchar(t[i]);
      if (c == '"') {
        i++;
        return out;
      }
      if (c < 0x20) fail("control character in string");
      if (c == '\\') {
        i++;
        if (i >= t.size()) fail("bad escape");
        char e = t[i++];
        switch (e) {
          case '"': out += QLatin1Char('"'); break;
          case '\\': out += QLatin1Char('\\'); break;
          case '/': out += QLatin1Char('/'); break;
          case 'b': out += QLatin1Char('\b'); break;
          case 'f': out += QLatin1Char('\f'); break;
          case 'n': out += QLatin1Char('\n'); break;
          case 'r': out += QLatin1Char('\r'); break;
          case 't': out += QLatin1Char('\t'); break;
          case 'u': {
            if (i + 4 > t.size()) fail("bad escape");
            int u = 0;
            for (int k = 0; k < 4; ++k) {
              int h = hexv(t[i + k]);
              if (h < 0) fail("bad escape");
              u = u * 16 + h;
            }
            i += 4;
            out += QChar(ushort(u));
            break;
          }
          default: fail("bad escape");
        }
        continue;
      }
      // UTF-8 sequence
      int len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
      if (len == 0 || i + len > t.size()) fail("invalid UTF-8");
      uint cp = len == 1 ? c : len == 2 ? (c & 0x1F) : len == 3 ? (c & 0x0F) : (c & 0x07);
      for (int k = 1; k < len; ++k) {
        unsigned char cc = uchar(t[i + k]);
        if ((cc >> 6) != 0x2) fail("invalid UTF-8");
        cp = (cp << 6) | (cc & 0x3F);
      }
      if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) || (cp >= 0xD800 && cp <= 0xDFFF))
        fail("invalid UTF-8");
      i += len;
      if (cp >= 0x10000) {
        cp -= 0x10000;
        out += QChar(ushort(0xD800 + (cp >> 10)));
        out += QChar(ushort(0xDC00 + (cp & 0x3FF)));
      } else {
        out += QChar(ushort(cp));
      }
    }
  }
  JValue num() {
    qsizetype s = i;
    if (t[i] == '-') i++;
    if (i < t.size() && t[i] == '0') i++;
    else if (i < t.size() && t[i] >= '1' && t[i] <= '9') {
      while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
    } else fail("number");
    if (i < t.size() && t[i] == '.') {
      i++;
      if (i >= t.size() || t[i] < '0' || t[i] > '9') fail("number");
      while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
    }
    if (i < t.size() && (t[i] == 'e' || t[i] == 'E')) {
      i++;
      if (i < t.size() && (t[i] == '+' || t[i] == '-')) i++;
      if (i >= t.size() || t[i] < '0' || t[i] > '9') fail("number");
      while (i < t.size() && t[i] >= '0' && t[i] <= '9') i++;
    }
    std::string sv(t.constData() + s, size_t(i - s));
    double d = std::strtod(sv.c_str(), nullptr);
    if (!std::isfinite(d)) fail("non-finite number");
    return JValue(d);
  }
};
}  // namespace

JValue parseJsonOrThrow(const QByteArray& utf8, JParseOptions opt) {
  if (utf8.size() > opt.maxBytes) throw std::runtime_error("document too large");
  Parser p{utf8, 0, opt.maxDepth};
  JValue v = p.value(0);
  p.ws();
  if (p.i != utf8.size()) throw std::runtime_error("trailing data");
  return v;
}

JValue parseJson(const QByteArray& utf8, QString* error, JParseOptions opt) {
  try {
    JValue v = parseJsonOrThrow(utf8, opt);
    if (error) error->clear();
    return v;
  } catch (const std::exception& e) {
    if (error) *error = QString::fromUtf8(e.what());
    return JValue();
  }
}

QString asText(const JValue& v) {
  switch (v.kind()) {
    case JValue::Kind::Missing:
    case JValue::Kind::Null: return QString();
    case JValue::Kind::String: return v.str();
    case JValue::Kind::Number: return jsNumberToString(v.toNumber());
    case JValue::Kind::Bool: return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    default: return v.stringify();
  }
}

bool isReservedKey(const QString& key) {
  return key == QLatin1String("__proto__") || key == QLatin1String("prototype") || key == QLatin1String("constructor");
}

bool pointerIsValid(const QString& pointer) {
  static const QRegularExpression re(QStringLiteral("^(/[A-Za-z0-9_-]{1,64}){0,8}$"));
  return re.match(pointer).hasMatch();
}

JValue readPointer(const JValue& root, const QString& pointer) {
  if (!pointerIsValid(pointer)) return JValue();
  if (pointer.isEmpty()) return root;
  static const QRegularExpression idx(QStringLiteral("^(0|[1-9][0-9]{0,5})$"));
  JValue cur = root;
  const QStringList segs = pointer.mid(1).split(QLatin1Char('/'));
  for (const QString& seg : segs) {
    if (isReservedKey(seg)) return JValue();
    if (cur.isArray()) {
      if (!idx.match(seg).hasMatch()) return JValue();
      cur = cur.at(seg.toInt());
    } else if (cur.isObject()) {
      const JValue* f = cur.find(seg);
      if (!f) return JValue();
      cur = *f;
    } else {
      return JValue();
    }
  }
  return cur;
}

int codePointLength(const QString& s) {
  int n = 0;
  for (int i = 0; i < s.size(); ++i) {
    if (s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate()) ++i;
    ++n;
  }
  return n;
}

}  // namespace agentos
