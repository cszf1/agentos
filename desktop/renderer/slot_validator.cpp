#include "slot_validator.hpp"

#include "json_schema.hpp"

#include <QFile>
#include <QRegularExpression>
#include <memory>

namespace agentos {

const JValue& slotSchemaDocuments() {
  static const JValue docs = [] {
    QFile f(QStringLiteral(":/agentos/renderer/slot-schemas.json"));
    if (!f.open(QIODevice::ReadOnly)) qFatal("slot-schemas.json missing from resources");
    return parseJsonOrThrow(f.readAll(), {64, 4 * 1024 * 1024});
  }();
  return docs;
}

static const MiniSchema& schemaFor(int version) {
  static const MiniSchema v1(slotSchemaDocuments().get(QStringLiteral("v1")));
  static const MiniSchema v2(slotSchemaDocuments().get(QStringLiteral("v2")));
  return version == 2 ? v2 : v1;
}

SlotTreeContext contextForBundle(const JValue& bundle) {
  SlotTreeContext c;
  c.queries = bundle.get(QStringLiteral("queries"));
  c.commands = bundle.get(QStringLiteral("commands"));
  if (bundle.get(QStringLiteral("formatVersion")).toNumber() == 3) {
    c.systemActions = bundle.get(QStringLiteral("system")).get(QStringLiteral("actions"));
    c.viewKind = QStringLiteral("slot-tree-v2");
  }
  return c;
}

namespace {

const QSet<QString> kSlotNames = {QStringLiteral("main"), QStringLiteral("toolbar"), QStringLiteral("aside")};
const QStringList kSlotOrder = {QStringLiteral("main"), QStringLiteral("toolbar"), QStringLiteral("aside")};
const QSet<QString> kV1Types = {"Stack", "Grid", "Tabs", "Text", "Alert", "Metric", "Table", "Kanban", "Form", "TextInput", "TextArea",
                                "Select", "Checkbox", "Button", "BarChart", "LineChart", "SystemActionButton"};
const QSet<QString> kV2Only = {"SystemActionButton", "List"};
const QSet<QString> kContainers = {"Stack", "Grid", "Tabs", "Form", "List"};
const QSet<QString> kInputs = {"TextInput", "TextArea", "Select", "Checkbox"};

bool isIdent(const QString& s) {
  static const QRegularExpression re(QStringLiteral("^[A-Za-z][A-Za-z0-9_]{0,63}$"));
  return re.match(s).hasMatch();
}

bool isBinding(const JValue& v) { return v.isObject() && v.has(QStringLiteral("$bind")); }

struct BindUse {
  JValue b;
  QString path;
  bool inItem;
};
struct Ref {
  QString id, path;
};

struct Walker {
  const SlotTreeContext& ctx;
  QVector<SlotIssue> issues;
  SlotTreeFacts facts;
  QString wantKind;
  int nodes = 0;
  int templateNodes = 0;
  QVector<BindUse> bindings;
  QVector<Ref> selectionUses, formRefs;
  int version() const { return wantKind == QLatin1String("slot-tree-v2") ? 2 : 1; }

  void add(const QString& path, const QString& message, const QString& code = QStringLiteral("INVALID_SLOT_TREE")) {
    if (issues.size() < 40) issues.push_back({path, code, message});
  }

  void collectBindings(const JValue& value, const QString& path, bool inItem, int depth = 0) {
    if (depth > 6) return;
    if (isBinding(value)) {
      if (!schemaFor(version()).validateDef(QStringLiteral("binding"), value)) add(path, QStringLiteral("invalid binding"));
      else bindings.push_back({value, path, inItem});
      return;
    }
    if (value.isArray()) {
      for (int i = 0; i < value.size(); ++i) collectBindings(value.at(i), path + QLatin1Char('/') + QString::number(i), inItem, depth + 1);
    } else if (value.isObject()) {
      for (const auto& m : value.members()) collectBindings(m.second, path + QLatin1Char('/') + m.first, inItem, depth + 1);
    }
  }

  void walk(const JValue& node, const QString& path, int depth, std::optional<QString> formId, std::optional<QString> listPath) {
    const bool inItem = listPath.has_value();
    if (inItem && ++templateNodes == ui_limits::listMaxTemplateNodes + 1)
      add(*listPath, QStringLiteral("a list item template holds at most %1 nodes").arg(ui_limits::listMaxTemplateNodes));
    nodes++;
    if (nodes > ui_limits::maxNodes) {
      if (nodes == ui_limits::maxNodes + 1) add(path, QStringLiteral("the tree holds at most %1 nodes").arg(ui_limits::maxNodes));
      return;
    }
    if (depth > ui_limits::maxDepth) return add(path, QStringLiteral("the tree is at most %1 levels deep").arg(ui_limits::maxDepth));
    if (!node.isObject()) return add(path, QStringLiteral("node must be an object"));
    for (const auto& m : node.members()) {
      const QString& k = m.first;
      if (k != QLatin1String("type") && k != QLatin1String("props") && k != QLatin1String("children") && k != QLatin1String("visibleWhen"))
        add(path + QLatin1Char('/') + k, QStringLiteral("unknown node field \"%1\"").arg(k));
    }
    const JValue& typeV = node.get(QStringLiteral("type"));
    const QString type = typeV.isString() ? typeV.str() : QString();
    const bool known = typeV.isString() && (version() == 2 ? (kV1Types.contains(type) || type == QLatin1String("List")) : kV1Types.contains(type));
    if (!known) return add(path + QStringLiteral("/type"), QStringLiteral("unknown component \"%1\"").arg(asText(typeV)));
    if (kV2Only.contains(type) && version() != 2) return add(path + QStringLiteral("/type"), QStringLiteral("%1 needs slot-tree-v2 (formatVersion 3)").arg(type));
    JValue props = node.get(QStringLiteral("props"));
    if (props.isNullish()) props = JValue::object();
    QString ep, em;
    if (!schemaFor(version()).validateDef(type, props, &ep, &em)) {
      add(path + QStringLiteral("/props") + ep, type + QStringLiteral(": ") + em);
      return;
    }
    const JValue& p = props;
    if (node.has(QStringLiteral("visibleWhen"))) {
      const JValue& w = node.get(QStringLiteral("visibleWhen"));
      bool okShape = false;
      if (w.isObject() && isBinding(w.get(QStringLiteral("value")))) {
        const JValue& op = w.get(QStringLiteral("op"));
        if (op.isString() && op.str() == QLatin1String("exists") && w.size() == 2) okShape = true;
        if (op.isString() && op.str() == QLatin1String("eq") && w.size() == 3 && w.has(QStringLiteral("equals"))) {
          const JValue& eq = w.get(QStringLiteral("equals"));
          okShape = eq.isNull() || eq.isString() || eq.isNumber() || eq.isBool();
        }
      }
      if (!okShape) add(path + QStringLiteral("/visibleWhen"), QStringLiteral("visibleWhen supports {value, op:'exists'} and {value, op:'eq', equals: scalar}"));
      else collectBindings(w.get(QStringLiteral("value")), path + QStringLiteral("/visibleWhen/value"), inItem);
    }
    const bool itemScoped = type == QLatin1String("Table") || type == QLatin1String("Kanban");
    collectBindings(p, path + QStringLiteral("/props"), inItem);
    if (type == QLatin1String("List") && inItem) add(path, QStringLiteral("lists cannot be nested"));
    if (itemScoped) {
      const JValue& sid = p.get(QStringLiteral("selectionId"));
      if (sid.isString()) {
        if (inItem) add(path + QStringLiteral("/props/selectionId"), QStringLiteral("a selection cannot be declared inside a list item (it would repeat per item)"));
        if (facts.selections.contains(sid.str())) add(path + QStringLiteral("/props/selectionId"), QStringLiteral("selection \"%1\" is declared twice").arg(sid.str()));
        facts.selections.insert(sid.str());
      }
    }
    if (type == QLatin1String("Form")) {
      if (inItem) add(path, QStringLiteral("forms cannot be inside a list item (form ids would repeat per item)"));
      if (formId.has_value()) add(path, QStringLiteral("forms cannot be nested"));
      const QString id = p.get(QStringLiteral("formId")).str();
      if (facts.forms.contains(id)) add(path + QStringLiteral("/props/formId"), QStringLiteral("form \"%1\" is declared twice").arg(id));
      facts.forms.insert(id, {});
      formId = id;
    }
    if (kInputs.contains(type)) {
      if (inItem) add(path, QStringLiteral("%1 cannot be inside a list item (input names would repeat per item)").arg(type));
      else if (!formId.has_value()) add(path, QStringLiteral("%1 must be inside a Form").arg(type));
      else {
        QSet<QString>& names = facts.forms[*formId];
        const QString name = p.get(QStringLiteral("name")).str();
        if (names.contains(name)) add(path + QStringLiteral("/props/name"), QStringLiteral("input \"%1\" appears twice in form \"%2\"").arg(name, *formId));
        names.insert(name);
      }
    }
    auto inputRefs = [&](const JValue& input) {
      if (input.has(QStringLiteral("form"))) formRefs.push_back({input.get(QStringLiteral("form")).str(), path + QStringLiteral("/props/input/form")});
      if (input.has(QStringLiteral("selection")))
        selectionUses.push_back({input.get(QStringLiteral("selection")).get(QStringLiteral("selectionId")).str(), path + QStringLiteral("/props/input/selection")});
      if (input.has(QStringLiteral("item")) && !inItem) add(path + QStringLiteral("/props/input/item"), QStringLiteral("input.item is only valid inside a list item"));
    };
    if (type == QLatin1String("Button")) {
      const QString cmd = p.get(QStringLiteral("command")).str();
      if (!ctx.commands.has(cmd)) add(path + QStringLiteral("/props/command"), QStringLiteral("command \"%1\" is not declared").arg(cmd), QStringLiteral("UNKNOWN_HANDLER"));
      inputRefs(p.get(QStringLiteral("input")));
    }
    if (type == QLatin1String("SystemActionButton")) {
      const QString act = p.get(QStringLiteral("action")).str();
      if (!ctx.systemActions.isObject() || !ctx.systemActions.has(act))
        add(path + QStringLiteral("/props/action"), QStringLiteral("system action \"%1\" is not declared").arg(act), QStringLiteral("UNKNOWN_HANDLER"));
      inputRefs(p.get(QStringLiteral("input")));
    }
    if (node.has(QStringLiteral("children"))) {
      const JValue& children = node.get(QStringLiteral("children"));
      if (!kContainers.contains(type)) return add(path + QStringLiteral("/children"), QStringLiteral("%1 has no children").arg(type));
      if (!children.isArray()) return add(path + QStringLiteral("/children"), QStringLiteral("children must be an array"));
      if (children.size() > ui_limits::maxChildren) add(path + QStringLiteral("/children"), QStringLiteral("at most %1 children").arg(ui_limits::maxChildren));
      if (type == QLatin1String("Tabs") && children.size() != p.get(QStringLiteral("labels")).size())
        add(path + QStringLiteral("/children"), QStringLiteral("Tabs needs one child per label"));
      if (type == QLatin1String("List") && children.size() == 0) add(path + QStringLiteral("/children"), QStringLiteral("List needs an item template (at least one child)"));
      if (type == QLatin1String("List") && !inItem) templateNodes = 0;
      std::optional<QString> childList = type == QLatin1String("List") ? std::optional<QString>(path) : listPath;
      for (int i = 0; i < children.size(); ++i)
        walk(children.at(i), path + QStringLiteral("/children/") + QString::number(i), depth + 1, formId, childList);
    } else if (type == QLatin1String("Tabs")) {
      add(path + QStringLiteral("/children"), QStringLiteral("Tabs needs one child per label"));
    } else if (type == QLatin1String("List")) {
      add(path + QStringLiteral("/children"), QStringLiteral("List needs an item template (at least one child)"));
    }
  }
};

}  // namespace

QVector<SlotIssue> checkSlotTree(const JValue& view, const SlotTreeContext& ctx, SlotTreeFacts* factsOut, const QString& root) {
  Walker w{ctx, {}, {}, ctx.viewKind.isEmpty() ? QStringLiteral("slot-tree-v1") : ctx.viewKind};
  auto done = [&]() {
    if (factsOut) *factsOut = w.facts;
    return w.issues;
  };
  if (!view.isObject()) {
    w.add(root, QStringLiteral("view must be an object"));
    return done();
  }
  for (const auto& m : view.members()) {
    const QString& k = m.first;
    if (k != QLatin1String("kind") && k != QLatin1String("dataSources") && k != QLatin1String("slots") && k != QLatin1String("refresh"))
      w.add(root + QLatin1Char('/') + k, QStringLiteral("unknown view field \"%1\"").arg(k));
  }
  const JValue& kind = view.get(QStringLiteral("kind"));
  if (!(kind.isString() && kind.str() == w.wantKind)) w.add(root + QStringLiteral("/kind"), QStringLiteral("view.kind must be \"%1\"").arg(w.wantKind));
  const JValue& sources = view.get(QStringLiteral("dataSources"));
  QSet<QString> sourceNames;
  if (!sources.isObject()) w.add(root + QStringLiteral("/dataSources"), QStringLiteral("dataSources must be an object"));
  else {
    if (sources.size() > ui_limits::maxDataSources) w.add(root + QStringLiteral("/dataSources"), QStringLiteral("at most %1 data sources").arg(ui_limits::maxDataSources));
    for (const auto& m : sources.members()) {
      const QString p = root + QStringLiteral("/dataSources/") + m.first;
      if (!isIdent(m.first) || isReservedKey(m.first)) w.add(p, QStringLiteral("data source names are ASCII identifiers"));
      sourceNames.insert(m.first);
      const JValue& d = m.second;
      if (!d.isObject()) {
        w.add(p, QStringLiteral("data source must be an object"));
        continue;
      }
      for (const auto& dm : d.members())
        if (dm.first != QLatin1String("queryId") && dm.first != QLatin1String("input")) w.add(p + QLatin1Char('/') + dm.first, QStringLiteral("unknown field \"%1\"").arg(dm.first));
      const JValue& q = d.get(QStringLiteral("queryId"));
      if (!q.isString() || !ctx.queries.has(q.str()))
        w.add(p + QStringLiteral("/queryId"), QStringLiteral("query \"%1\" is not declared").arg(q.isMissing() ? QStringLiteral("undefined") : asText(q)), QStringLiteral("UNKNOWN_HANDLER"));
      if (d.has(QStringLiteral("input")) && !d.get(QStringLiteral("input")).isObject()) w.add(p + QStringLiteral("/input"), QStringLiteral("input must be an object"));
    }
  }
  if (view.has(QStringLiteral("refresh"))) {
    const JValue& r = view.get(QStringLiteral("refresh"));
    const JValue s = r.isObject() ? r.get(QStringLiteral("intervalSeconds")) : JValue();
    bool extra = false;
    for (const auto& m : r.members())
      if (m.first != QLatin1String("intervalSeconds")) extra = true;
    // JS: !r (null/false/0/"") or not an object -> s undefined -> invalid
    if (!r.isObject() || extra || !s.isSafeInteger() || s.toNumber() < ui_limits::minRefreshSeconds || s.toNumber() > ui_limits::maxRefreshSeconds)
      w.add(root + QStringLiteral("/refresh"), QStringLiteral("refresh.intervalSeconds must be an integer %1..%2").arg(ui_limits::minRefreshSeconds).arg(ui_limits::maxRefreshSeconds));
  }
  const JValue& slotsV = view.get(QStringLiteral("slots"));
  if (!slotsV.isObject()) {
    w.add(root + QStringLiteral("/slots"), QStringLiteral("slots must be an object"));
    return done();
  }
  for (const auto& m : slotsV.members())
    if (!kSlotNames.contains(m.first)) w.add(root + QStringLiteral("/slots/") + m.first, QStringLiteral("apps only control the slots main, toolbar, aside"));
  if (!slotsV.has(QStringLiteral("main"))) w.add(root + QStringLiteral("/slots/main"), QStringLiteral("the main slot is required"));
  for (const QString& name : kSlotOrder) {
    const JValue* node = slotsV.find(name);
    if (node && !node->isMissing()) w.walk(*node, root + QStringLiteral("/slots/") + name, 1, std::nullopt, std::nullopt);
  }
  for (const auto& u : w.bindings) {
    const JValue& b = u.b.get(QStringLiteral("$bind"));
    const QString from = b.get(QStringLiteral("from")).str();
    if (from == QLatin1String("query") && !sourceNames.contains(b.get(QStringLiteral("source")).str()))
      w.add(u.path, QStringLiteral("data source \"%1\" is not declared").arg(b.get(QStringLiteral("source")).str()));
    if (from == QLatin1String("form") && !w.facts.forms.contains(b.get(QStringLiteral("formId")).str()))
      w.add(u.path, QStringLiteral("form \"%1\" is not declared").arg(b.get(QStringLiteral("formId")).str()));
    if (from == QLatin1String("selection") && !w.facts.selections.contains(b.get(QStringLiteral("selectionId")).str()))
      w.add(u.path, QStringLiteral("selection \"%1\" is not declared").arg(b.get(QStringLiteral("selectionId")).str()));
    if (from == QLatin1String("item") && !u.inItem) w.add(u.path, QStringLiteral("item bindings are only valid inside a list item"));
  }
  for (const auto& s : w.selectionUses)
    if (!w.facts.selections.contains(s.id)) w.add(s.path, QStringLiteral("selection \"%1\" is not declared").arg(s.id));
  for (const auto& f : w.formRefs)
    if (!w.facts.forms.contains(f.id)) w.add(f.path, QStringLiteral("form \"%1\" is not declared").arg(f.id));
  return done();
}

}  // namespace agentos
