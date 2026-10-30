#pragma once
// Defensive re-check of a Slot Tree (spec §10.2): a C++ port of checkSlotTree in packages/contracts/src/v2/ui.ts.
// The Host remains the authority; the Shell refuses to render a tree this check rejects (error card instead).
#include "jvalue.hpp"

#include <QMap>
#include <QSet>
#include <QVector>

namespace agentos {

struct SlotIssue {
  QString path;
  QString code;
  QString message;
};

struct SlotTreeContext {
  JValue queries = JValue::object();
  JValue commands = JValue::object();
  JValue systemActions;  // missing for v1
  QString viewKind = QStringLiteral("slot-tree-v1");
};

struct SlotTreeFacts {
  QMap<QString, QSet<QString>> forms;
  QSet<QString> selections;
};

namespace ui_limits {
constexpr int maxNodes = 256, maxDepth = 12, maxChildren = 64, maxSeries = 8, maxPointsPerSeries = 500;
constexpr int minRefreshSeconds = 5, maxRefreshSeconds = 3600, maxDataSources = 8;
constexpr int listMaxItems = 100, listDefaultItems = 50, listMaxTemplateNodes = 24;
constexpr int liveInstanceBudget = 4096;
}  // namespace ui_limits

/** Schema documents (v1, v2) embedded from renderer/slot-schemas.json. */
const JValue& slotSchemaDocuments();

QVector<SlotIssue> checkSlotTree(const JValue& view, const SlotTreeContext& ctx, SlotTreeFacts* facts = nullptr,
                                 const QString& root = QStringLiteral("/view"));

/** Context for a code bundle (formatVersion 2 or 3) the way the Host builds it. */
SlotTreeContext contextForBundle(const JValue& bundle);

}  // namespace agentos
