import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Strings.js" as Strings

FocusScope {
    id: root
    objectName: "shellRoot"
    property Item sureFor: null
    function askSure(btn) { sureFor = btn }
    Connections { target: root.shellRef
        function onScopeCleared(reason) { root.sureFor = null }
        function onPageChanged() { root.sureFor = null }
    }
    Shortcut { sequences: ["Ctrl+=", "Ctrl++"]; onActivated: shell.zoom(1) }
    Shortcut { sequence: "Ctrl+-"; onActivated: shell.zoom(-1) }
    Shortcut { sequence: "Ctrl+0"; onActivated: shell.zoom(0) }
    Shortcut { sequence: "F5"; onActivated: shell.refreshPage() }
    Shortcut { sequence: "Ctrl+Alt+L"; onActivated: shell.hardware("session.lock", {}) }

    property var shellRef: typeof shell !== "undefined" ? shell : null

    Rectangle {
        anchors.fill: parent
        color: Theme.bgApp
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // =====================================================================
        // Top System Status Bar
        // =====================================================================
        Rectangle {
            Layout.fillWidth: true
            height: Theme.px(44)
            color: Theme.bgSurface

            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                height: Theme.borderThin
                color: Theme.border
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.s3
                anchors.rightMargin: Theme.s3
                spacing: Theme.s2

                // System Identity Pill
                Rectangle {
                    implicitWidth: sysLabel.implicitWidth + Theme.s3
                    implicitHeight: Theme.px(26)
                    radius: Theme.radiusControl
                    color: Theme.bgSubtle
                    border.width: Theme.borderThin
                    border.color: Theme.border

                    PText {
                        id: sysLabel
                        anchors.centerIn: parent
                        text: Strings.app.systemTag
                        variant: "caption"
                        mono: true
                        bold: true
                    }
                }

                // Connection / Host / Model / Broker Status Pills
                Repeater {
                    model: [
                        { ok: root.shellRef ? root.shellRef.connected : true, textOk: Strings.status.connected, textDown: Strings.status.disconnected },
                        { ok: root.shellRef ? root.shellRef.brokerAvailable : true, textOk: Strings.status.brokerOk, textDown: Strings.status.brokerDown },
                        { ok: root.shellRef ? root.shellRef.modelAvailable : true, textOk: Strings.status.modelOk, textDown: Strings.status.modelDown }
                    ]
                    delegate: Rectangle {
                        required property var modelData
                        implicitWidth: pillRow.implicitWidth + Theme.s2 * 2
                        implicitHeight: Theme.px(24)
                        radius: Theme.px(12)
                        color: modelData.ok ? Theme.successSubtle : Theme.dangerSubtle
                        border.width: Theme.borderThin
                        border.color: modelData.ok ? Theme.successBorder : Theme.dangerBorder

                        RowLayout {
                            id: pillRow
                            anchors.centerIn: parent
                            spacing: Theme.px(6)

                            Rectangle {
                                width: Theme.px(6)
                                height: Theme.px(6)
                                radius: Theme.px(3)
                                color: modelData.ok ? Theme.success : Theme.danger
                            }

                            PText {
                                text: modelData.ok ? modelData.textOk : modelData.textDown
                                variant: "caption"
                                tone: modelData.ok ? "success" : "danger"
                                bold: true
                            }
                        }
                    }
                }

                Item { Layout.fillWidth: true }

                // Cached timestamp
                PText {
                    text: Strings.common.cachedAtPrefix + (root.shellRef ? root.shellRef.cachedAt : "")
                    variant: "caption"
                    mono: true
                    tone: "muted"
                }

                // Zoom Controls (0.8 .. 2.0)
                AButton {
                    label: "-"
                    compact: true
                    onConfirmed: { if (root.shellRef) root.shellRef.zoom(-1) }
                }

                PText {
                    text: Math.round((root.shellRef ? root.shellRef.uiScale : 1.0) * 100) + "%"
                    variant: "caption"
                    mono: true
                    bold: true
                }

                AButton {
                    label: "+"
                    compact: true
                    onConfirmed: { if (root.shellRef) root.shellRef.zoom(1) }
                }

                // Light / Dark Theme Toggle
                AButton {
                    label: Theme.dark ? Strings.common.themeLight : Strings.common.themeDark
                    iconName: Theme.dark ? "sun" : "moon"
                    compact: true
                    onConfirmed: { Theme.dark = !Theme.dark }
                }
                // Lock Session
                AButton {
                    label: Strings.common.lockScreen
                    iconName: "lock"
                    compact: true
                    onConfirmed: {
                        if (root.shellRef) root.shellRef.hardware("session.lock", {})
                    }
                }
            }
        }
        // =====================================================================
        // Mandatory Top Status Banner for ReadOnly / WritesStopped / Offline
        // =====================================================================
        Rectangle {
            objectName: "banner"
            readonly property bool hasWriteRestriction: root.shellRef ? root.shellRef.banner !== "" : false
            visible: hasWriteRestriction
            Layout.fillWidth: true
            height: Theme.px(38)
            color: (root.shellRef && (!root.shellRef.connected || root.shellRef.writesStopped)) ? Theme.dangerSubtle : Theme.warningSubtle

            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                height: Theme.borderThin
                color: (root.shellRef && (!root.shellRef.connected || root.shellRef.writesStopped)) ? Theme.dangerBorder : Theme.warningBorder
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.s4
                anchors.rightMargin: Theme.s4
                spacing: Theme.s2

                Image {
                    source: Theme.iconSource("incidents", ((root.shellRef && (!root.shellRef.connected || root.shellRef.writesStopped)) ? Theme.danger : Theme.warning).toString())
                    sourceSize.width: Theme.iconSm
                    sourceSize.height: Theme.iconSm
                }

                PText {
                    Layout.fillWidth: true
                    variant: "body"
                    bold: true
                    tone: (root.shellRef && (!root.shellRef.connected || root.shellRef.writesStopped)) ? "danger" : "warning"
                    text: root.shellRef ? root.shellRef.banner : ""
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

        // =====================================================================
        // Notice / Feedback Strip
        // =====================================================================
        Rectangle {
            visible: root.shellRef ? (root.shellRef.notice !== "") : false
            Layout.fillWidth: true
            height: Theme.px(34)
            color: Theme.accentSubtle

            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                height: Theme.borderThin
                color: Theme.accentBorder
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.s4
                anchors.rightMargin: Theme.s4
                spacing: Theme.s2

                PText {
                    Layout.fillWidth: true
                    objectName: "notice"
                    text: root.shellRef ? root.shellRef.notice : ""
                    variant: "caption"
                    tone: "accent"
                    bold: true
                    elide: Text.ElideRight
                }

                AButton {
                    label: Strings.common.dismiss
                    compact: true
                    variant: "secondary"
                    onConfirmed: { if (root.shellRef) root.shellRef.dismissNotice() }
                }
            }
        }

        // =====================================================================
        // Main Body: Left Navigation Sidebar + Right Page Content Area
        // =====================================================================
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Left Sidebar (232px * scale)
            Rectangle {
                Layout.preferredWidth: Theme.px(232)
                Layout.fillHeight: true
                color: Theme.bgSurface

                Rectangle {
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Theme.borderThin
                    color: Theme.border
                }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: Theme.s3
                    spacing: Theme.s2

                    // Current Workspace Switcher Header
                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: wsHeaderCol.implicitHeight + Theme.s2 * 2
                        radius: Theme.radiusControl
                        color: Theme.bgSubtle
                        border.width: Theme.borderThin
                        border.color: Theme.border

                        ColumnLayout {
                            id: wsHeaderCol
                            anchors.fill: parent
                            anchors.margins: Theme.s2
                            spacing: Theme.px(2)

                            PText { text: "当前工作空间"; variant: "caption"; tone: "secondary" }
                            PText {
                                Layout.fillWidth: true
                                text: root.shellRef ? root.shellRef.workspaceName : ""
                                variant: "body"
                                bold: true
                                elide: Text.ElideRight
                            }
                        }
                    }

                    ASelect {
                        objectName: "workspaceSwitcher"; Layout.fillWidth: true
                        label: "切换工作区"; value: shell.workspaceId
                        options: { var o = []; for (var i = 0; i < shell.workspaces.count; ++i) { var w = shell.workspaces.get(i); o.push({value:w.workspaceId,label:w.displayName || w.workspaceId}) } return o }
                        onChosen: function(v) { shell.switchWorkspace(v) }
                    }

                    // Navigation List (All 11 Pages)
                    ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        ColumnLayout {
                            width: parent.width
                            spacing: Theme.px(4)

                            PText { text: Strings.nav.sectionMain; variant: "caption"; tone: "muted"; bold: true; Layout.topMargin: Theme.s1 }

                            Repeater {
                                model: [
                                    { id: "home",       label: Strings.nav.home,       icon: "home",       badge: "" },
                                    { id: "workspaces", label: Strings.nav.workspaces, icon: "workspaces", badge: "" },
                                    { id: "app",  label: Strings.nav.appDetail,  icon: "apps",       badge: "" },
                                    { id: "tasks",      label: Strings.nav.tasks,      icon: "tasks",      badge: "" }
                                ]
                                delegate: ATab {
                                    required property var modelData
                                    objectName: "nav:" + modelData.id
                                    Layout.fillWidth: true
                                    fullWidth: true
                                    label: modelData.label
                                    iconName: modelData.icon
                                    badge: modelData.badge
                                    active: root.shellRef ? (root.shellRef.currentPage === modelData.id) : false
                                    onClicked: { if (root.shellRef) root.shellRef.currentPage = modelData.id }
                                }
                            }

                            PText { text: Strings.nav.sectionGov; variant: "caption"; tone: "muted"; bold: true; Layout.topMargin: Theme.s2 }

                            Repeater {
                                model: [
                                    { id: "proposals", label: Strings.nav.proposals, icon: "proposals", badge: "" },
                                    { id: "policies",  label: Strings.nav.policies,  icon: "policies",  badge: "" },
                                    { id: "incidents", label: Strings.nav.incidents, icon: "incidents", badge: "" }
                                ]
                                delegate: ATab {
                                    required property var modelData
                                    objectName: "nav:" + modelData.id
                                    Layout.fillWidth: true
                                    fullWidth: true
                                    label: modelData.label
                                    iconName: modelData.icon
                                    badge: modelData.badge
                                    active: root.shellRef ? (root.shellRef.currentPage === modelData.id) : false
                                    onClicked: { if (root.shellRef) root.shellRef.currentPage = modelData.id }
                                }
                            }

                            ATab { objectName: "nav:login"; Layout.fillWidth: true; fullWidth: true; label: "登录与设置"; iconName: "lock"; active: pageHost.activePage === "login"; onClicked: if (root.shellRef) root.shellRef.currentPage = "login" }
                            PText { text: Strings.nav.sectionSys; variant: "caption"; tone: "muted"; bold: true; Layout.topMargin: Theme.s2 }

                            Repeater {
                                model: [
                                    { id: "backup",      label: Strings.nav.backup,      icon: "backup",      badge: "" },
                                    { id: "update",      label: Strings.nav.update,      icon: "update",      badge: "" },
                                    { id: "hardware",    label: Strings.nav.hardware,    icon: "hardware",    badge: "" },
                                    { id: "diagnostics", label: Strings.nav.diagnostics, icon: "diagnostics", badge: "" }
                                ]
                                delegate: ATab {
                                    required property var modelData
                                    objectName: "nav:" + modelData.id
                                    Layout.fillWidth: true
                                    fullWidth: true
                                    label: modelData.label
                                    iconName: modelData.icon
                                    badge: modelData.badge
                                    active: root.shellRef ? (root.shellRef.currentPage === modelData.id) : false
                                    onClicked: { if (root.shellRef) root.shellRef.currentPage = modelData.id }
                                }
                            }
                        }
                    }

                    // Operator & Role Footer Card
                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: userFooterCol.implicitHeight + Theme.s2 * 2
                        radius: Theme.radiusControl
                        color: Theme.bgSubtle
                        border.width: Theme.borderThin
                        border.color: Theme.border

                        ColumnLayout {
                            id: userFooterCol
                            anchors.fill: parent
                            anchors.margins: Theme.s2
                            spacing: Theme.px(2)

                            RowLayout {
                                Layout.fillWidth: true
                                PText {
                                    Layout.fillWidth: true
                                    text: root.shellRef ? root.shellRef.userName : ""
                                    variant: "body"
                                    mono: true
                                    bold: true
                                }
                                Rectangle {
                                    implicitWidth: roleTag.implicitWidth + Theme.s2
                                    implicitHeight: Theme.px(20)
                                    radius: Theme.px(4)
                                    color: (root.shellRef && root.shellRef.role === "viewer") ? Theme.warningSubtle : Theme.accentSubtle

                                    PText {
                                        id: roleTag
                                        anchors.centerIn: parent
                                        text: root.shellRef ? root.shellRef.role : ""
                                        variant: "caption"
                                        tone: (root.shellRef && root.shellRef.role === "viewer") ? "warning" : "accent"
                                        bold: true
                                    }
                                }
                            }

                            PText {
                                visible: root.shellRef && root.shellRef.role === "viewer"
                                Layout.fillWidth: true
                                text: Strings.roles.viewerHint
                                variant: "caption"
                                tone: "warning"
                            }
                        }
                    }
                }
            }

            // Right Page View Container (11 Pages)
            Loader {
                id: pageHost
                objectName: "page"
                clip: true
                Layout.fillWidth: true
                Layout.fillHeight: true
                readonly property string activePage: root.shellRef ? root.shellRef.currentPage : "home"
                sourceComponent: {
                    switch (activePage) {
                    case "home": return homeC
                    case "login": return loginC
                    case "workspaces": return workspacesC
                    case "app": return appC
                    case "tasks": return tasksC
                    case "proposals": return proposalsC
                    case "policies": return policiesC
                    case "incidents": return incidentsC
                    case "backup": return backupC
                    case "update": return updateC
                    case "hardware": return hardwareC
                    case "diagnostics": return diagnosticsC
                    default: return homeC
                    }
                }
            }
            Component { id: homeC; HomePage { } }
            Component { id: loginC; LoginPage { } }
            Component { id: workspacesC; WorkspacesPage { } }
            Component { id: appC; AppDetailPage { } }
            Component { id: tasksC; TaskCenterPage { } }
            Component { id: proposalsC; ProposalsPage { } }
            Component { id: policiesC; PoliciesPage { } }
            Component { id: incidentsC; IncidentsPage { } }
            Component { id: backupC; BackupPage { } }
            Component { id: updateC; UpdatePage { } }
            Component { id: hardwareC; HardwarePage { } }
            Component { id: diagnosticsC; DiagnosticsPage { } }

        }
    }

    // =========================================================================
    // Global Modal & System Security Layers (Strict Z-Order Hierarchy)
    // =========================================================================
    Rectangle {
        id: sure
        objectName: "dangerSure"
        anchors.fill: parent; z: 850; visible: root.sureFor !== null; color: Theme.scrimModal
        Accessible.role: Accessible.Dialog; Accessible.name: "确认危险操作"
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; hoverEnabled: true; onWheel: function(w) { w.accepted = true } }
        onVisibleChanged: if (visible) sureNo.forceActiveFocus()
        Keys.onEscapePressed: root.sureFor = null
        Rectangle {
            anchors.centerIn: parent; width: Math.min(parent.width - 40, 420 * Theme.scale); height: sureCol.implicitHeight + 32
            radius: 8; color: Theme.bgSurface; border.color: Theme.danger; border.width: 1
            Column { id: sureCol; x: 16; y: 16; width: parent.width - 32; spacing: 10
                PText { objectName: "dangerSureText"; width: parent.width; variant: "title"; text: "确定要" + (root.sureFor ? root.sureFor.label : "") + "吗？" }
                PText { width: parent.width; variant: "muted"; text: "这是危险操作，请再确认一次。" }
                Row { spacing: 10
                    AButton { objectName: "dangerSureAccept"; label: "确定"; askSure: false; onClicked: { var t = root.sureFor; root.sureFor = null; if (t) t.confirmed() } }
                    AButton { id: sureNo; objectName: "dangerSureCancel"; label: "取消"; onClicked: root.sureFor = null } } }
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
        PText { anchors.centerIn: parent; text: "会话已锁定"; tone: "onAccent"; variant: "title" }
    }

    ServiceBlocked {
        anchors.fill: parent
    }

    TrustedConfirm {
        anchors.fill: parent
    }
}
