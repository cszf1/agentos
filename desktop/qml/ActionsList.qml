import QtQuick
// Async action states: accepted / in progress / needs confirmation / reconciled (never "done" on HTTP 202).
Column {
    id: a
    property string prefix: ""
    property int limit: 6
    spacing: 4
    PText { text: "操作状态"; font.bold: true }
    Repeater {
        model: shell.actions
        delegate: Row {
            visible: !!row && (a.prefix === "" || String(row.name).indexOf(a.prefix) === 0) && index < a.limit
            height: visible ? implicitHeight : 0
            spacing: 8
            PText { text: row ? row.label : ""; width: 220 * shell.uiScale; elide: Text.ElideRight; maximumLineCount: 1 }
            PText { objectName: "actionState"; text: row ? row.stateText : ""; color: !row ? "#1f1f1f" : row.state === "failed" ? "#a01515" : row.state === "reconciled" ? "#13703a" : row.state === "unknown" ? "#7a5a00" : "#1f3f7a" }
            PText { text: row && row.detail ? row.detail : ""; variant: "small"; width: 260 * shell.uiScale; elide: Text.ElideRight; maximumLineCount: 1 }
            AButton { visible: !!row && (row.state === "unknown" || row.state === "failed"); label: "重试（同一请求）"; onClicked: shell.retryAction(row.id) }
        }
    }
}
