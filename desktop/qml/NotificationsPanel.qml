import QtQuick
import QtQuick.Layouts

// Notifications from the workspace Host, newest first; nothing here is an action by itself.
Rectangle {
    id: np
    objectName: "notificationsPanel"
    property var shellRoot: null
    property var shellRef: typeof shell !== "undefined" ? shell : null
    width: Theme.px(340)
    height: Math.min(Theme.px(460), col.implicitHeight + Theme.s3 * 2)
    radius: Theme.radiusCard
    color: Theme.bgElevated
    border.width: Theme.borderThin
    border.color: Theme.border
    clip: true
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onWheel: function(w) { w.accepted = true } }

    ColumnLayout {
        id: col
        anchors.fill: parent
        anchors.margins: Theme.s3
        spacing: Theme.s2
        PText { text: "通知"; variant: "subhead"; bold: true }
        Repeater {
            model: np.shellRef ? np.shellRef.notifications : null
            delegate: ColumnLayout {
                visible: index < 8
                Layout.fillWidth: true
                spacing: Theme.px(2)
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.s2
                    Rectangle {
                        width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3)
                        color: row.severity === "critical" || row.severity === "error" ? Theme.danger : (row.severity === "warning" ? Theme.warning : Theme.textMuted)
                    }
                    PText {
                        objectName: "notificationPanelItem:" + row.id
                        Layout.fillWidth: true
                        text: (row.title || "") + (row.count > 1 ? "（" + row.count + " 次）" : "")
                        elide: Text.ElideRight; wrapMode: Text.NoWrap
                    }
                }
                PText { visible: !!row.body; Layout.fillWidth: true; Layout.leftMargin: Theme.px(14); text: row.body || ""; variant: "caption"; tone: "secondary"; maximumLineCount: 2; elide: Text.ElideRight }
            }
        }
        PText { visible: !np.shellRef || np.shellRef.notifications.count === 0; text: "没有新通知"; tone: "muted" }
        MenuRow { iconName: "tasks"; label: "查看任务"; onClicked: if (np.shellRoot) np.shellRoot.go("tasks") }
    }
}
