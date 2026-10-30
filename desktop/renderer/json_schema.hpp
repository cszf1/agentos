#pragma once
// The JSON Schema subset the Slot Tree props schemas use (type/enum/const/required/properties/additionalProperties/
// pattern/maxLength/minimum/maximum/minItems/maxItems/items/maxProperties/anyOf/oneOf/$ref "#/$defs/x").
// The schema documents themselves are the TS contract's slotTreeSchemaDocument(1|2), embedded in the binary and
// checked against fixtures/v1.0/slot-vectors/schemas.json by the vector test.
#include "jvalue.hpp"

namespace agentos {

class MiniSchema {
 public:
  explicit MiniSchema(JValue document) : doc_(std::move(document)) {}
  /** Validate `value` against `#/$defs/<def>`; on failure `errorPath` gets the instance path of the first error. */
  bool validateDef(const QString& def, const JValue& value, QString* errorPath = nullptr, QString* message = nullptr) const;
  bool validate(const JValue& schema, const JValue& value, const QString& path, QString* errorPath, QString* message) const;
  const JValue& document() const { return doc_; }

 private:
  JValue doc_;
  const JValue& resolveRef(const QString& ref) const;
};

}  // namespace agentos
