import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "Strings.js" as Strings

// Top bar: workspace on the left, the time in the middle, health / notifications / you on the right.
// It shares the desktop's colour: no line, no fill. The last 20 px on the right stay empty (a safe focus click).
Item {
    id: bar
    objectName: "topBar"
    property var shellRoot: null
    property var shellRef: typeof shell !== "undefined" ? shell : null
    implicitHeight: Theme.topBarHeight

    readonly property bool healthy: !shellRef || (shellRef.connected && shellRef.hostAvailable && shellRef.modelAvailable && shellRef.brokerAvailable && !shellRef.writesStopped)
    readonly property string healthText: {
        if (!shellRef) return ""
        if (!shellRef.connected) return Strings.status.disconnected
        if (shellRef.writesStopped) return "已停写"
        if (!shellRef.hostAvailable) return "工作区服务不可用"
        if (!shellRef.modelAvailable) return "未连接模型"
        if (!shellRef.brokerAvailable) return Strings.status.brokerDown
        return ""
    }

    property date now: new Date()
    Timer { interval: 15000; running: true; repeat: true; triggeredOnStart: true; onTriggered: bar.now = new Date() }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: Theme.px(10)
        anchors.rightMargin: Theme.px(22)
        spacing: Theme.px(6)

        // Workspace: the name, quietly; choosing another switches
        TextMetrics { id: wsMetrics; font: ws.font; text: ws.displayText }
        ASelect {
            id: ws
            objectName: "workspaceSwitcher"
            flat: true
            compact: true
            Layout.preferredWidth: Math.min(Theme.px(260), Math.max(Theme.px(72), wsMetrics.advanceWidth + Theme.px(44)))
            label: "切换工作区"
            value: shell.workspaceId
            options: { var o = []; for (var i = 0; i < shell.workspaces.count; ++i) { var w = shell.workspaces.get(i); o.push({value:w.workspaceId,label:w.displayName || w.workspaceId}) } return o }
            onChosen: function(v) { shell.switchWorkspace(v) }
        }

        Item { Layout.fillWidth: true }

        // Health: invisible when all is well, one quiet chip when not
        BarButton {
            objectName: "healthChip"
            visible: !bar.healthy
            text: bar.healthText
            dotColor: (bar.shellRef && (!bar.shellRef.connected || bar.shellRef.writesStopped || !bar.shellRef.hostAvailable)) ? Theme.danger : Theme.warning
            onClicked: if (bar.shellRoot) bar.shellRoot.go(bar.shellRef && !bar.shellRef.modelAvailable && bar.shellRef.connected && bar.shellRef.hostAvailable ? "model" : "diagnostics")
        }

        BarButton {
            objectName: "notificationsButton"
            iconName: "bell"
            Accessible.name: "通知"
            badge: bar.shellRef && bar.shellRef.notifications.count > 0 ? String(bar.shellRef.notifications.count) : ""
            active: bar.shellRoot && bar.shellRoot.popover === "notifications"
            onClicked: if (bar.shellRoot) bar.shellRoot.popover = (bar.shellRoot.popover === "notifications" ? "" : "notifications")
        }

        // You: initial in a circle, opens the control centre (theme, scale, lock, settings)
        Button {
            id: me
            objectName: "controlCenterButton"
            Accessible.name: "控制中心"
            focusPolicy: Qt.StrongFocus
            implicitWidth: Theme.px(26); implicitHeight: Theme.px(26)
            onClicked: if (bar.shellRoot) bar.shellRoot.popover = (bar.shellRoot.popover === "control" ? "" : "control")
            background: Rectangle {
                radius: width / 2
                color: me.hovered || (bar.shellRoot && bar.shellRoot.popover === "control") ? Theme.accent : Theme.bgMuted
                border.width: me.activeFocus ? Theme.focusWidth : 0
                border.color: Theme.borderFocus
                Behavior on color { ColorAnimation { duration: Theme.animFast } }
            }
            contentItem: Text {
                text: (bar.shellRef && bar.shellRef.userName ? bar.shellRef.userName : "·").charAt(0).toUpperCase()
                textFormat: Text.PlainText
                horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
                font.family: Theme.fontFamily; font.pixelSize: Theme.textCaption; font.weight: Font.DemiBold
                color: me.hovered || (bar.shellRoot && bar.shellRoot.popover === "control") ? Theme.textOnAccent : Theme.textPrimary
            }
        }
    }

    // The clock, centred on the bar regardless of the sides
    PText {
        objectName: "clock"
        anchors.centerIn: parent
        text: (bar.now.getMonth() + 1) + "月" + bar.now.getDate() + "日  周" + "日一二三四五六".charAt(bar.now.getDay()) + "  " + Qt.formatTime(bar.now, "HH:mm")
        variant: "body"
        tone: "secondary"
        wrapMode: Text.NoWrap
    }
}
