#pragma once
// Plain JSON data with JavaScript semantics: "missing" (undefined) is distinct from null, numbers are doubles,
// objects keep insertion order (so asText/JSON.stringify match the web renderer byte for byte).
#include <QByteArray>
#include <QString>
#include <QStringList>
#include <QVariant>
#include <memory>
#include <utility>
#include <vector>

namespace agentos {

class JValue;
using JArray = std::vector<JValue>;
using JMember = std::pair<QString, JValue>;
using JObject = std::vector<JMember>;

class JValue {
 public:
  enum class Kind { Missing, Null, Bool, Number, String, Array, Object };

  JValue() = default;  // missing
  static JValue missing() { return JValue(); }
  static JValue null();
  JValue(bool v);
  JValue(double v);
  JValue(int v) : JValue(double(v)) {}
  JValue(qint64 v) : JValue(double(v)) {}
  JValue(const QString& v);
  JValue(const char* v) : JValue(QString::fromUtf8(v)) {}
  static JValue array(JArray items = {});
  static JValue object(JObject members = {});

  Kind kind() const { return kind_; }
  bool isMissing() const { return kind_ == Kind::Missing; }
  bool isNull() const { return kind_ == Kind::Null; }
  bool isNullish() const { return kind_ == Kind::Missing || kind_ == Kind::Null; }
  bool isBool() const { return kind_ == Kind::Bool; }
  bool isNumber() const { return kind_ == Kind::Number; }
  bool isString() const { return kind_ == Kind::String; }
  bool isArray() const { return kind_ == Kind::Array; }
  bool isObject() const { return kind_ == Kind::Object; }
  bool isSafeInteger() const;

  bool toBool() const { return b_; }
  double toNumber() const { return n_; }
  const QString& str() const { return s_; }
  QString stringOr(const QString& def) const { return isString() ? s_ : def; }

  // arrays
  int size() const;
  const JValue& at(int i) const;  // missing when out of range or not an array
  const JArray& items() const;
  void push(const JValue& v);
  // objects
  const JValue* find(const QString& key) const;
  const JValue& get(const QString& key) const;  // missing when absent
  bool has(const QString& key) const { return find(key) != nullptr; }
  const JObject& members() const;
  QStringList keys() const;
  void set(const QString& key, const JValue& v);  // replaces in place, appends when new
  void remove(const QString& key);

  /** JavaScript === for scalars; arrays/objects compare by identity (never equal to a scalar). */
  bool strictEquals(const JValue& o) const;
  /** Structural equality (used by tests and by "unchanged field" checks on scalars). */
  bool deepEquals(const JValue& o) const;

  /** JSON.stringify(value) (missing -> empty QString with *undefinedOut = true). */
  QString stringify(bool* undefinedOut = nullptr) const;
  QByteArray toJsonUtf8() const { return stringify().toUtf8(); }
  QVariant toVariant() const;
  static JValue fromVariant(const QVariant& v);

 private:
  Kind kind_ = Kind::Missing;
  bool b_ = false;
  double n_ = 0;
  QString s_;
  std::shared_ptr<JArray> a_;
  std::shared_ptr<JObject> o_;
  void detach();
};

struct JParseOptions {
  int maxDepth = 32;
  qsizetype maxBytes = 4 * 1024 * 1024;
};

/** Strict JSON: UTF-8 checked, duplicate keys, trailing data, non-finite numbers and over-deep nesting rejected. */
JValue parseJson(const QByteArray& utf8, QString* error, JParseOptions opt = {});
JValue parseJsonOrThrow(const QByteArray& utf8, JParseOptions opt = {});

QString jsNumberToString(double d);
/** String(x) / asText semantics of the web renderer. */
QString asText(const JValue& v);
/** Restricted JSON Pointer over own properties (^(/[A-Za-z0-9_-]{1,64}){0,8}$, no reserved names). */
JValue readPointer(const JValue& root, const QString& pointer);
bool pointerIsValid(const QString& pointer);
bool isReservedKey(const QString& key);
int codePointLength(const QString& s);

}  // namespace agentos
