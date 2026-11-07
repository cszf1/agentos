import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Strings.js" as Strings

// The desktop: a quiet top bar, the current surface (desktop, an app, tasks or settings) and a dock.
// System pages live inside Settings; the trusted confirmation and lock layers stay above everything.
FocusScope {
    id: root
    objectName: "shellRoot"
    property Item sureFor: null
    function askSure(btn) {
        sureFor = btn
        sureNo.forceActiveFocus()
    }
    property var shellRef: typeof shell !== "undefined" ? shell : null
    readonly property string page: shellRef ? shellRef.currentPage : "home"
    readonly property var settingsPages: ["model", "workspaces", "login", "proposals", "policies", "incidents", "backup", "update", "hardware", "diagnostics"]
    readonly property bool inSettings: settingsPages.indexOf(page) >= 0
    property string lastSettingsPage: "model"
    // (not inSettings: that binding may not have caught up with page yet when this handler runs)
    onPageChanged: { if (settingsPages.indexOf(page) >= 0) lastSettingsPage = page; popover = "" }
    function go(p) { if (shellRef) shellRef.currentPage = p }
    function openSettings() { go(lastSettingsPage) }
    // "" | "control" | "notifications"
    property string popover: ""

    Connections { target: root.shellRef
        function onScopeCleared(reason) { root.sureFor = null; root.popover = "" }
        function onPageChanged() { root.sureFor = null }
    }
    Shortcut { sequences: ["Ctrl+=", "Ctrl++"]; onActivated: shell.zoom(1) }
    Shortcut { sequence: "Ctrl+-"; onActivated: shell.zoom(-1) }
    Shortcut { sequence: "Ctrl+0"; onActivated: shell.zoom(0) }
    Shortcut { sequence: "F5"; onActivated: shell.refreshPage() }
    Shortcut { sequence: "Ctrl+Alt+L"; onActivated: shell.hardware("session.lock", {}) }
    Shortcut { sequence: "Ctrl+,"; onActivated: root.openSettings() }
    Shortcut { sequence: "Meta+D"; onActivated: root.go("home") }

    Rectangle { anchors.fill: parent; color: Theme.bgApp }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        TopBar {
            Layout.fillWidth: true
            shellRoot: root
        }

        // Mandatory strip for read-only / writes stopped / offline
        Rectangle {
            objectName: "banner"
            readonly property bool severe: root.shellRef && (!root.shellRef.connected || root.shellRef.writesStopped)
            visible: root.shellRef ? root.shellRef.banner !== "" : false
            Layout.fillWidth: true
            Layout.leftMargin: Theme.s3
            Layout.rightMargin: Theme.s3
            Layout.bottomMargin: Theme.s2
            implicitHeight: Theme.px(36)
            radius: Theme.radiusControl
            color: severe ? Theme.dangerSubtle : Theme.warningSubtle
            border.width: Theme.borderThin
            border.color: severe ? Theme.dangerBorder : Theme.warningBorder
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.s3
                anchors.rightMargin: Theme.px(6)
                spacing: Theme.s2
                Image {
                    source: Theme.iconSource("incidents", parent.parent.severe ? "danger" : "warning")
                    sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm
                }
                PText {
                    Layout.fillWidth: true
                    variant: "body"
                    tone: parent.parent.severe ? "danger" : "warning"
                    text: root.shellRef ? root.shellRef.banner : ""
                    elide: Text.ElideRight
                    wrapMode: Text.NoWrap
                }
                AButton {
                    visible: root.shellRef ? !root.shellRef.connected : false
                    objectName: "reconnect"
                    label: Strings.blocked.reconnectBtn
                    compact: true
                    variant: "primary"
                    onConfirmed: { if (root.shellRef) root.shellRef.reconnect() }
                }
            }
        }

        // The current surface
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            Loader {
                id: pageHost
                objectName: "page"
                anchors.fill: parent
                clip: true
                readonly property string activePage: root.page
                sourceComponent: {
                    if (root.inSettings) return settingsC
                    switch (activePage) {
                    case "home": return homeC
                    case "app": return appC
                    case "tasks": return tasksC
                    default: return homeC
                    }
                }
            }
            Component { id: homeC; HomePage { shellRoot: root } }
            Component { id: appC; AppDetailPage { } }
            Component { id: tasksC; TaskCenterPage { } }
            Component { id: settingsC; SettingsPage { } }

            // Notice: a quiet toast above the dock
            Rectangle {
                id: toast
                visible: root.shellRef ? (root.shellRef.notice !== "") : false
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Theme.s3
                width: Math.min(parent.width - Theme.s6, toastRow.implicitWidth + Theme.s3 + Theme.px(6))
                height: Theme.px(40)
                radius: Theme.radiusPill
                color: Theme.bgTrustedBar
                z: 20
                RowLayout {
                    id: toastRow
                    anchors.fill: parent
                    anchors.leftMargin: Theme.s3
                    anchors.rightMargin: Theme.px(6)
                    spacing: Theme.s2
                    PText {
                        Layout.fillWidth: true
                        Layout.maximumWidth: Theme.px(640)
                        objectName: "notice"
                        text: root.shellRef ? root.shellRef.notice : ""
                        variant: "body"
                        color: Theme.textOnDark
                        elide: Text.ElideRight
                        wrapMode: Text.NoWrap
                    }
                    Button {
                        id: dismissNotice
                        Accessible.name: Strings.common.dismiss
                        implicitWidth: Theme.px(28); implicitHeight: Theme.px(28)
                        focusPolicy: Qt.StrongFocus
                        onClicked: if (root.shellRef) root.shellRef.dismissNotice()
                        background: Rectangle { radius: width / 2; color: dismissNotice.hovered ? "#33FFFFFF" : "transparent" }
                        contentItem: Image { source: Theme.iconSource("close", "white"); sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm; fillMode: Image.Pad }
                    }
                }
            }
        }

        // Dock (its own row: content never runs under it)
        Item {
            Layout.fillWidth: true
            implicitHeight: Theme.dockHeight + Theme.px(12) * 2
            Dock {
                anchors.centerIn: parent
                shellRoot: root
            }
        }
    }

    // ---- popovers (control centre, notifications): click outside closes ----
    MouseArea {
        anchors.fill: parent
        z: 700
        visible: root.popover !== ""
        onClicked: root.popover = ""
        onWheel: function(w) { w.accepted = true }
    }
    ControlCenter {
        z: 701
        visible: root.popover === "control"
        anchors.top: parent.top
        anchors.topMargin: Theme.topBarHeight + Theme.px(4)
        anchors.right: parent.right
        anchors.rightMargin: Theme.s3
        shellRoot: root
    }
    NotificationsPanel {
        z: 701
        visible: root.popover === "notifications"
        anchors.top: parent.top
        anchors.topMargin: Theme.topBarHeight + Theme.px(4)
        anchors.right: parent.right
        anchors.rightMargin: Theme.s3
        shellRoot: root
    }

    // ---- the red second click: default focus on 取消 ----
    Rectangle {
        id: sure
        objectName: "dangerSure"
        anchors.fill: parent; z: 850; visible: root.sureFor !== null; color: Theme.scrimModal
        Accessible.role: Accessible.Dialog; Accessible.name: "确认危险操作"
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; hoverEnabled: true; onWheel: function(w) { w.accepted = true }; onClicked: root.sureFor = null }
        onVisibleChanged: if (visible) sureNo.forceActiveFocus()
        Keys.onEscapePressed: root.sureFor = null
        Rectangle {
            anchors.centerIn: parent
            width: Math.min(parent.width - Theme.s6, Theme.px(420))
            height: sureCol.implicitHeight + Theme.s4 * 2
            radius: Theme.radiusModal
            color: Theme.bgSurface
            border.color: Theme.border
            border.width: Theme.borderThin
            MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons }
            ColumnLayout {
                id: sureCol
                anchors.fill: parent
                anchors.margins: Theme.s4
                spacing: Theme.s2
                PText { text: "需要再次确认"; variant: "caption"; tone: "danger" }
                PText { objectName: "dangerSureText"; Layout.fillWidth: true; variant: "title"; text: "确定要" + (root.sureFor ? root.sureFor.label : "") + "吗？" }
                PText { Layout.fillWidth: true; variant: "body"; tone: "secondary"; text: "此操作不易撤销。默认选中“取消”。" }
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.s3
                    spacing: Theme.s2
                    Item { Layout.fillWidth: true }
                    AButton {
                        id: sureNo
                        objectName: "dangerSureCancel"
                        label: "取消"
                        variant: "secondary"
                        KeyNavigation.tab: sureYes
                        KeyNavigation.backtab: sureYes
                        onConfirmed: root.sureFor = null
                    }
                    AButton {
                        id: sureYes
                        objectName: "dangerSureAccept"
                        label: "确定"
                        variant: "danger"
                        askSure: false
                        KeyNavigation.tab: sureNo
                        KeyNavigation.backtab: sureNo
                        onConfirmed: { var t = root.sureFor; root.sureFor = null; if (t) t.confirmed() }
                    }
                }
            }
        }
    }
    AppConfirm {
        anchors.fill: parent
    }

    // The real lock is handled by the session agent/swaylock. Never show a fake password field.
    Rectangle {
        objectName: "lockMask"
        anchors.fill: parent
        z: 850
        visible: root.shellRef && root.shellRef.locked
        color: Theme.bgTrustedBar
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons }
        PText { anchors.centerIn: parent; text: "会话已锁定"; color: Theme.textOnDark; variant: "title" }
    }

    ServiceBlocked {
        anchors.fill: parent
    }

    TrustedConfirm {
        anchors.fill: parent
    }
}
