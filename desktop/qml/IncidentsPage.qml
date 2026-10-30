import QtQuick
PageFrame {
    title: "事件（incident）"
    Repeater { model: shell.incidents
        delegate: Column { spacing: 1
            PText { text: (row.condition || "") + " — " + (row.target ? row.target.kind + ":" + row.target.id : "") + " — " + (row.state || ""); font.bold: true }
            PText { text: "证据 " + (row.evidenceCount || 0) + " 条，质量 " + (row.quality || "") + "，最后出现 " + (row.lastSeenAt || ""); variant: "small" } } }
    PText { visible: shell.incidents.count === 0; text: "没有未结事件"; variant: "muted" }
}
