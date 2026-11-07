import QtQuick
import QtQuick.Layouts

PageFrame {
    title: "异常事件"
    subtitle: "系统与工作区的异常，以及诊断证据"
    Repeater {
        model: shell.incidents
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: content.implicitHeight + Theme.s3 * 2
            color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
            ColumnLayout {
                id: content; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: (row.condition || "") + " — " + (row.target ? row.target.kind + ":" + row.target.id : "") + " — " + (row.state || ""); bold: true }
                PText { text: "证据 " + (row.evidenceCount || 0) + " 条，质量 " + (row.quality || "") + "，最后出现 " + (row.lastSeenAt || ""); tone: "secondary"; variant: "caption" }
            }
        }
    }
    Rectangle {
        visible: shell.incidents.count === 0
        Layout.fillWidth: true
        implicitHeight: emptyIncCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: emptyIncCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            PText { text: "没有未结事件"; tone: "muted" }
        }
    }
}
