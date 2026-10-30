#pragma once
// formatVersion 1 records view (spec §10.2 row 1, V1-D02): port of slot-vectors-records.ts / web AppView.tsx.
#include "jvalue.hpp"
#include "slot_runtime.hpp"

namespace agentos::records {
constexpr int kPage = 20;
JValue defaultDraft(const JValue& bundle);
QString displayValue(const JValue& field, const JValue& v);
JValue fieldInput(const JValue& field, const JValue& raw);  // raw: string or bool
ForwardRequest listRequest(const QString& appId, const JValue& bundle, const QString& q, const JValue& filters, int offset);
JValue changeFilter(const JValue& bundle, const JValue& filters, const QString& key, const QString& v);
JValue keepFilters(const JValue& bundle, const JValue& filters);
JValue openEdit(const JValue& bundle, const JValue& data);
JValue localIssues(const JValue& bundle, const JValue& draft);
QString valueIssue(const JValue& field, const JValue& value);  // Host's valueIssue(fieldSpec(f), v)
ForwardRequest createRequest(const QString& appId, double appEpoch, const JValue& draft, const QString& key);
std::optional<ForwardRequest> editRequest(const QString& appId, double appEpoch, const JValue& record, const JValue& draft, const QString& key);
ForwardRequest deleteRequest(const QString& appId, double appEpoch, const JValue& record, const QString& key);
JValue rebase(const JValue& bundle, const QString& mode, const JValue& draft);
ForwardRequest deployRequest(const QString& appId, double appEpoch, const QString& revisionId, const QString& key);
QString keyAfter(const QString& outcome);
}  // namespace agentos::records
