import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: root
    property string prefix: ""
    property int limit: 6
    Layout.fillWidth: true
    spacing: Theme.s2
    PText { text: "操作状态"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.actions
        delegate: Rectangle {
            readonly property bool shown: !!row && (root.prefix === "" || String(row.name).indexOf(root.prefix) === 0) && index < root.limit
            visible: shown; Layout.fillWidth: true
            implicitHeight: shown ? dataRow.implicitHeight + Theme.s3 * 2 : 0
            color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
            RowLayout {
                id: dataRow; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: row ? row.label || row.name : ""; Layout.preferredWidth: Theme.px(220); elide: Text.ElideRight }
                PText { objectName: "actionState"; text: row ? row.stateText || row.state : "";
                    tone: row && row.state === "failed" ? "danger" : row && row.state === "reconciled" ? "success" : "secondary" }
                PText { Layout.fillWidth: true; text: row ? row.detail || "" : ""; variant: "caption"; elide: Text.ElideRight }
                AButton { visible: !!row && (row.state === "unknown" || row.state === "failed"); label: "重试（同一请求）"; compact: true;
                    onConfirmed: if (row) shell.retryAction(row.id) }
            }
        }
    }
}
