import QtQuick
import QtQuick.Layouts
import "Strings.js" as Strings

// Control centre: who you are, appearance, scale, lock, settings.
Rectangle {
    id: cc
    objectName: "controlCenter"
    property var shellRoot: null
    property var shellRef: typeof shell !== "undefined" ? shell : null
    width: Theme.px(300)
    height: col.implicitHeight + Theme.s3 * 2
    radius: Theme.radiusCard
    color: Theme.bgElevated
    border.width: Theme.borderThin
    border.color: Theme.border
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onWheel: function(w) { w.accepted = true } }

    ColumnLayout {
        id: col
        anchors.fill: parent
        anchors.margins: Theme.s3
        spacing: Theme.s3

        RowLayout {
            spacing: Theme.s2
            Rectangle {
                width: Theme.px(36); height: Theme.px(36); radius: width / 2; color: Theme.bgMuted
                PText { anchors.centerIn: parent; text: (cc.shellRef && cc.shellRef.userName ? cc.shellRef.userName : "·").charAt(0).toUpperCase(); bold: true }
            }
            ColumnLayout {
                spacing: 0
                Layout.fillWidth: true
                PText { text: cc.shellRef ? cc.shellRef.userName : ""; bold: true; elide: Text.ElideRight; wrapMode: Text.NoWrap; Layout.fillWidth: true }
                PText {
                    text: (cc.shellRef ? ({viewer: "查看者", editor: "编辑者", owner: "所有者"}[cc.shellRef.role] || cc.shellRef.role) : "") + " · " + (cc.shellRef ? cc.shellRef.workspaceName : "")
                    variant: "caption"; tone: "secondary"; elide: Text.ElideRight; wrapMode: Text.NoWrap; Layout.fillWidth: true
                }
            }
        }

        Rectangle { Layout.fillWidth: true; height: Theme.borderThin; color: Theme.border }

        // Appearance: two segments
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.s2
            PText { text: "外观"; tone: "secondary"; Layout.fillWidth: true }
            Segmented {
                objectName: "themeToggle"
                options: [{value: "light", label: "浅色"}, {value: "dark", label: "深色"}]
                value: Theme.dark ? "dark" : "light"
                onChosen: function(v) { Theme.dark = (v === "dark") }
            }
        }
        // Scale
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.s2
            PText { text: Strings.common.scaleLabel; tone: "secondary"; Layout.fillWidth: true }
            AButton { label: "−"; compact: true; Layout.preferredWidth: Theme.px(36); onConfirmed: if (cc.shellRef) cc.shellRef.zoom(-1) }
            PText {
                text: Math.round((cc.shellRef ? cc.shellRef.uiScale : 1.0) * 100) + "%"
                variant: "caption"; mono: true
                horizontalAlignment: Text.AlignHCenter
                Layout.preferredWidth: Theme.px(44)
            }
            AButton { label: "+"; compact: true; Layout.preferredWidth: Theme.px(36); onConfirmed: if (cc.shellRef) cc.shellRef.zoom(1) }
        }

        Rectangle { Layout.fillWidth: true; height: Theme.borderThin; color: Theme.border }

        MenuRow { iconName: "settings"; label: "设置"; hint: "Ctrl+,"; onClicked: { if (cc.shellRoot) { cc.shellRoot.popover = ""; cc.shellRoot.openSettings() } } }
        MenuRow { iconName: "sparkle"; label: "模型"; hint: (cc.shellRef && cc.shellRef.modelAvailable) ? "已连接" : "未连接"; onClicked: { if (cc.shellRoot) { cc.shellRoot.popover = ""; cc.shellRoot.go("model") } } }
        MenuRow { objectName: "lockButton"; iconName: "lock"; label: Strings.common.lockScreen; hint: "Ctrl+Alt+L"; onClicked: { if (cc.shellRoot) cc.shellRoot.popover = ""; if (cc.shellRef) cc.shellRef.hardware("session.lock", {}) } }
    }
}
