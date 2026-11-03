import QtQuick
import QtQuick.Layouts

PageFrame {
    title: "事件"
    Repeater {
        model: shell.incidents
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: content.implicitHeight + Theme.s3 * 2
            color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border
            ColumnLayout {
                id: content; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: (row.condition || "") + " — " + (row.target ? row.target.kind + ":" + row.target.id : "") + " — " + (row.state || ""); bold: true }
                PText { text: "证据 " + (row.evidenceCount || 0) + " 条，质量 " + (row.quality || "") + "，最后出现 " + (row.lastSeenAt || ""); tone: "secondary"; variant: "caption" }
            }
        }
    }
    PText { visible: shell.incidents.count === 0; text: "没有未结事件"; tone: "muted" }
}
