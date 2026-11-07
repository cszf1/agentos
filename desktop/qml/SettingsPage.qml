import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings: every system page, grouped, in one window. The list on the left, the page on the right.
Item {
    id: root
    objectName: "settings"
    readonly property string page: shell.currentPage
    readonly property var groups: [
        { title: "", items: [
            { id: "model",      label: "模型",       icon: "sparkle" },
            { id: "workspaces", label: "工作区与成员", icon: "workspaces" },
            { id: "login",      label: "账户与会话",   icon: "user" } ] },
        { title: "维护", items: [
            { id: "proposals", label: "变更提案", icon: "proposals" },
            { id: "policies",  label: "维护策略", icon: "policies" },
            { id: "incidents", label: "异常事件", icon: "incidents" } ] },
        { title: "系统", items: [
            { id: "hardware",    label: "硬件与网络", icon: "hardware" },
            { id: "update",      label: "系统更新",   icon: "update" },
            { id: "backup",      label: "备份与恢复", icon: "backup" },
            { id: "diagnostics", label: "诊断",      icon: "diagnostics" } ] }
    ]

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: Theme.s3
        anchors.rightMargin: Theme.s3
        spacing: Theme.s3

        // the list
        Rectangle {
            Layout.preferredWidth: Theme.px(220)
            Layout.fillHeight: true
            radius: Theme.radiusCard
            color: Theme.bgSurface
            border.width: Theme.borderThin
            border.color: Theme.border
            ScrollView {
                anchors.fill: parent
                anchors.margins: Theme.px(8)
                clip: true
                contentWidth: availableWidth
                ColumnLayout {
                    width: parent.width
                    spacing: Theme.px(2)
                    PText { text: "设置"; variant: "title"; Layout.leftMargin: Theme.px(8); Layout.topMargin: Theme.px(6); Layout.bottomMargin: Theme.px(6) }
                    Repeater {
                        model: root.groups
                        delegate: ColumnLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            spacing: Theme.px(2)
                            PText { visible: modelData.title !== ""; text: modelData.title; variant: "caption"; tone: "muted"; Layout.leftMargin: Theme.px(8); Layout.topMargin: Theme.s2 }
                            Repeater {
                                model: modelData.items
                                delegate: MenuRow {
                                    required property var modelData
                                    objectName: "nav:" + modelData.id
                                    label: modelData.label
                                    iconName: modelData.icon
                                    active: root.page === modelData.id
                                    onClicked: shell.currentPage = modelData.id
                                }
                            }
                        }
                    }
                }
            }
        }

        // the page
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: Theme.radiusCard
            color: Theme.bgSurface
            border.width: Theme.borderThin
            border.color: Theme.border
            clip: true
            Loader {
                id: sub
                objectName: "settingsPage"
                anchors.fill: parent
                anchors.margins: Theme.borderThin
                sourceComponent: {
                    switch (root.page) {
                    case "model": return modelC
                    case "workspaces": return workspacesC
                    case "login": return loginC
                    case "proposals": return proposalsC
                    case "policies": return policiesC
                    case "incidents": return incidentsC
                    case "backup": return backupC
                    case "update": return updateC
                    case "hardware": return hardwareC
                    case "diagnostics": return diagnosticsC
                    default: return modelC
                    }
                }
            }
            Component { id: modelC; ModelPage { } }
            Component { id: workspacesC; WorkspacesPage { } }
            Component { id: loginC; LoginPage { } }
            Component { id: proposalsC; ProposalsPage { } }
            Component { id: policiesC; PoliciesPage { } }
            Component { id: incidentsC; IncidentsPage { } }
            Component { id: backupC; BackupPage { } }
            Component { id: updateC; UpdatePage { } }
            Component { id: hardwareC; HardwarePage { } }
            Component { id: diagnosticsC; DiagnosticsPage { } }
        }
    }
}
