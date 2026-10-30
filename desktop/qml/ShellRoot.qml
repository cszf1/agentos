import QtQuick
import QtQuick.Controls.Basic
// Shell frame: top bar (workspace switcher, status), degraded-mode banner, navigation, the page, and the trusted
// layers (system confirmation, lock mask) above everything generated.
Item {
    id: root
    objectName: "shellRoot"
    readonly property real s: shell.uiScale
    readonly property var pages: [
        { id: "home", label: "首页" }, { id: "login", label: "登录与设置" }, { id: "workspaces", label: "工作区与成员" },
        { id: "app", label: "应用与版本" }, { id: "tasks", label: "任务中心" }, { id: "policies", label: "维护策略" },
        { id: "incidents", label: "事件" }, { id: "proposals", label: "候选提议" }, { id: "diagnostics", label: "运行时诊断" },
        { id: "backup", label: "备份与恢复" }, { id: "update", label: "系统更新" }, { id: "hardware", label: "硬件设置" } ]
    Shortcut { sequences: ["Ctrl+=", "Ctrl++"]; onActivated: shell.zoom(1) }
    Shortcut { sequence: "Ctrl+-"; onActivated: shell.zoom(-1) }
    Shortcut { sequence: "Ctrl+0"; onActivated: shell.zoom(0) }
    Shortcut { sequence: "F5"; onActivated: shell.refreshPage() }
    Shortcut { sequence: "Ctrl+Alt+L"; onActivated: shell.hardware("session.lock", {}) }

    Rectangle {
        id: top
        width: parent.width; height: topRow.implicitHeight + 12; color: "#1f2937"
        Row {
            id: topRow; x: 8; y: 6; spacing: 10
            ASelect { id: wsSel; objectName: "workspaceSwitcher"; label: "切换工作区"; width: 220 * root.s; value: shell.workspaceId
                      options: { var o = []; for (var i = 0; i < shell.workspaces.count; ++i) { var w = shell.workspaces.get(i); o.push({ value: w.workspaceId, label: w.displayName || w.workspaceId }) } return o }
                      onChosen: function(v) { shell.switchWorkspace(v) } }
            Text { color: "#ffffff"; textFormat: Text.PlainText; font.pixelSize: 14 * root.s; anchors.verticalCenter: parent.verticalCenter
                   text: (shell.sessionBound ? shell.userName + "（" + shell.role + "）" : "未绑定会话") }
            Text { color: shell.connected ? "#9be29b" : "#ffb4b4"; textFormat: Text.PlainText; font.pixelSize: 13 * root.s; anchors.verticalCenter: parent.verticalCenter
                   text: (shell.connected ? "● 已连接" : "● 断开") + "  Host " + (shell.hostAvailable ? "正常" : "不可用") + "  模型 " + (shell.modelAvailable ? "可用" : "不可用") + "  Broker " + (shell.brokerAvailable ? "可用" : "不可用") }
            AButton { label: "锁定"; onClicked: shell.hardware("session.lock", {}) }
        }
    }
    Rectangle {
        id: banner
        objectName: "banner"
        anchors.top: top.bottom; width: parent.width
        height: shell.banner !== "" || shell.notice !== "" ? bannerCol.implicitHeight + 10 : 0
        visible: height > 0
        color: shell.connected ? "#fff4d6" : "#fde7e7"
        Column { id: bannerCol; x: 10; y: 5; width: parent.width - 20; spacing: 2
            Row { spacing: 8; visible: shell.banner !== ""
                PText { text: shell.banner; Accessible.role: Accessible.AlertMessage }
                AButton { visible: !shell.connected; objectName: "reconnect"; label: "重新连接"; onClicked: shell.reconnect() } }
            Row { spacing: 8; visible: shell.notice !== ""
                PText { objectName: "notice"; text: shell.notice; Accessible.role: Accessible.StatusBar }
                AButton { label: "知道了"; onClicked: shell.dismissNotice() } } }
    }
    Rectangle {
        id: nav
        anchors.top: banner.bottom; anchors.bottom: parent.bottom
        width: 150 * root.s; color: "#f3f4f6"
        Column { x: 6; y: 8; width: parent.width - 12; spacing: 4
            Repeater { model: root.pages
                delegate: AButton { width: parent.width; label: modelData.label; objectName: "nav:" + modelData.id
                                    variant: shell.currentPage === modelData.id ? "primary" : "secondary"; onClicked: shell.currentPage = modelData.id } } }
    }
    Loader {
        id: pageLoader
        objectName: "page"
        anchors.top: banner.bottom; anchors.bottom: parent.bottom; anchors.left: nav.right; anchors.right: parent.right
        clip: true
        z: 0
        sourceComponent: {
            switch (shell.currentPage) {
            case "login": return loginC
            case "workspaces": return workspacesC
            case "app": return appC
            case "tasks": return tasksC
            case "policies": return policiesC
            case "incidents": return incidentsC
            case "proposals": return proposalsC
            case "diagnostics": return diagnosticsC
            case "backup": return backupC
            case "update": return updateC
            case "hardware": return hardwareC
            default: return homeC
            }
        }
    }
    Component { id: homeC; HomePage { } }
    Component { id: loginC; LoginPage { } }
    Component { id: workspacesC; WorkspacesPage { } }
    Component { id: appC; AppDetailPage { } }
    Component { id: tasksC; TaskCenterPage { } }
    Component { id: policiesC; PoliciesPage { } }
    Component { id: incidentsC; IncidentsPage { } }
    Component { id: proposalsC; ProposalsPage { } }
    Component { id: diagnosticsC; DiagnosticsPage { } }
    Component { id: backupC; BackupPage { } }
    Component { id: updateC; UpdatePage { } }
    Component { id: hardwareC; HardwarePage { } }

    // Shell-side mask while locked. The real lock is swaylock/ext-session-lock; this only hides content meanwhile.
    Rectangle {
        objectName: "lockMask"
        anchors.fill: parent; z: 900; visible: shell.locked; color: "#111827"
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons }
        Text { anchors.centerIn: parent; color: "#ffffff"; textFormat: Text.PlainText; font.pixelSize: 22 * root.s; text: "会话已锁定" }
    }
    TrustedConfirm { anchors.fill: parent }
}
