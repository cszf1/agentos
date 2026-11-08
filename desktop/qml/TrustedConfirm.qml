import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "Strings.js" as Strings

// Trusted Shell-owned confirmation. Never app-provided content, never an app confirmation.
FocusScope {
    id: root
    objectName: "trustedConfirm"
    property var shellRef: typeof shell !== "undefined" ? shell : null
    readonly property var c: shellRef ? shellRef.confirm : ({})
    readonly property bool isOpen: !!c.visible
    readonly property bool needsPassword: !!c.admin
    anchors.fill: parent
    visible: isOpen
    z: 1000
    focus: visible
    Accessible.role: Accessible.Dialog
    Accessible.name: "AgentOS 系统确认"

    function resetPasswordAndFocus() {
        adminPwdField.boundValue = ""
        if (isOpen) Qt.callLater(function() { cancelBtn.forceActiveFocus() })
    }
    onIsOpenChanged: resetPasswordAndFocus()
    Connections {
        target: root.shellRef
        ignoreUnknownSignals: true
        function onScopeCleared(reason) { root.resetPasswordAndFocus() }
    }
    Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
            if (root.shellRef) root.shellRef.confirmReject()
            event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            event.accepted = true  // Enter never confirms a system plan.
        }
    }
    Rectangle {
        anchors.fill: parent; color: Theme.bgTrustedScrim
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(mouse) { mouse.accepted = true } }
    }
    Rectangle {
        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
        height: Theme.px(56); color: Theme.bgTrustedBar
        Rectangle { anchors.top: parent.top; width: parent.width; height: Theme.px(3); color: Theme.warning }
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: Theme.s4; anchors.rightMargin: Theme.s4; spacing: Theme.s3
            Image { source: Theme.iconSource("shield", "white"); sourceSize.width: Theme.iconMd; sourceSize.height: Theme.iconMd }
            PText { text: "AgentOS 系统确认 · 应用无法修改此框"; color: Theme.textOnDark; bold: true; Layout.fillWidth: true }
            PText { text: root.needsPassword ? "需管理员身份复核" : "受信任系统操作"; color: Theme.textOnDark; variant: "caption" }
        }
    }
    Rectangle {
        id: panel
        anchors.centerIn: parent
        anchors.verticalCenterOffset: Theme.px(16)
        width: Math.min(parent.width - Theme.s6, Theme.px(680))
        height: Math.min(parent.height - Theme.px(100), content.implicitHeight + footer.implicitHeight + Theme.s4 * 3)
        radius: Theme.radiusModal
        color: Theme.bgTrustedCard
        border.width: Theme.focusWidth
        border.color: Theme.warning
        ScrollView {
            anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
            anchors.bottom: footer.top; anchors.margins: Theme.s4
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            ColumnLayout {
                id: content
                width: panel.width - Theme.s4 * 2 - Theme.px(12)
                spacing: Theme.s2
                PText { Layout.fillWidth: true; text: root.c.title || "系统操作"; variant: "title"; bold: true }
                PText { Layout.fillWidth: true; objectName: "confirmWhat"; text: "做什么：" + (root.c.what || ""); wrapMode: Text.Wrap }
                PText { Layout.fillWidth: true; text: "用户：" + (root.c.user || "") }
                PText { Layout.fillWidth: true; text: "工作区：" + (root.c.workspace || "") }
                PText { Layout.fillWidth: true; text: "资源：" + (root.c.resource || "—") }
                PText { Layout.fillWidth: true; text: "效果：" + (root.c.effect || "") }
                PText { Layout.fillWidth: true; objectName: "confirmBefore"; text: "变更前：" + (root.c.before || "") }
                PText { Layout.fillWidth: true; objectName: "confirmAfter"; text: "变更后：" + (root.c.after || "") }
                Rectangle { Layout.fillWidth: true; height: Theme.borderThin; color: Theme.border }
                PText { Layout.fillWidth: true; objectName: "confirmRisk"; text: "风险：" + (root.c.risk || ""); tone: "danger"; bold: true }
                PText { Layout.fillWidth: true; objectName: "confirmReversible"; text: "能否撤销：" + (root.c.reversible || "") }
                PText { Layout.fillWidth: true; objectName: "confirmExpires"; text: "计划有效期：" + (root.c.expires || "") }
                PText { Layout.fillWidth: true; text: "计划 hash：" + (root.c.planHash || "—"); mono: true; variant: "caption" }
                PText { Layout.fillWidth: true; text: "版本/基线：" + (root.c.version || "—") }
                PText { Layout.fillWidth: true; text: "权限变化：" + (root.c.permissionChange || "") }
                PText { Layout.fillWidth: true; text: root.c.unknownNote || ""; tone: "warning"; variant: "caption" }
                PText { Layout.fillWidth: true; visible: !!root.c.stale; text: "计划已过期（身份、会话或工作区已变化），请重新生成计划。"; tone: "danger"; bold: true }
            }
        }
        ColumnLayout {
            id: footer
            anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
            anchors.margins: Theme.s4; spacing: Theme.s2
            PText { Layout.fillWidth: true; visible: root.needsPassword; text: "管理员密码（最多 511 个 UTF-8 字节，允许冒号）"; bold: true }
            AField {
                id: adminPwdField
                objectName: "confirmAdminPassword"
                visible: root.needsPassword
                Layout.fillWidth: true
                label: "管理员密码（当前管理员自己的密码）"
                sensitive: true
                placeholder: "只用于本次可信确认，不留存"
                enterSubmits: false
                KeyNavigation.tab: acceptBtn
                KeyNavigation.backtab: cancelBtn
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.s2; spacing: Theme.s3
                AButton {
                    id: cancelBtn; objectName: "confirmReject"
                    label: "取消"; enterActivates: true
                    KeyNavigation.tab: root.needsPassword ? adminPwdField : acceptBtn
                    KeyNavigation.backtab: acceptBtn
                    onConfirmed: { adminPwdField.boundValue = ""; if (root.shellRef) root.shellRef.confirmReject() }
                }
                Item { Layout.fillWidth: true }
                AButton {
                    id: acceptBtn; objectName: "confirmAccept"
                    label: "确认执行"; variant: "primary"; askSure: false; enterActivates: false
                    enabled: !root.c.stale && (!root.needsPassword || (root.shellRef && root.shellRef.passwordValid(adminPwdField.boundValue)))
                    KeyNavigation.tab: cancelBtn
                    KeyNavigation.backtab: root.needsPassword ? adminPwdField : cancelBtn
                    onConfirmed: {
                        if (!root.shellRef) return
                        var pw = adminPwdField.boundValue
                        adminPwdField.boundValue = ""
                        root.shellRef.confirmAccept(pw)
                    }
                }
            }
        }
    }
}
