import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

PageFrame {
    id: root
    title: "工作区与成员"
    subtitle: "每个工作区有自己的应用、数据和模型；成员角色为查看者、编辑者或所有者"
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: topCardCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: topCardCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s3
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.s3
                AField { id: wsName; label: "新工作区名称"; placeholder: "工作区名称"; Layout.preferredWidth: Theme.px(240) }
                AButton { label: "创建工作区"; variant: "primary"; writeAction: true; enabled: wsName.boundValue !== ""
                    onConfirmed: shell.act("workspaces.create", {displayName:wsName.boundValue}, "创建工作区") }
                Item { Layout.fillWidth: true }
            }
            Repeater { model: shell.workspaces
                delegate: RowLayout { visible: row.workspaceId === shell.workspaceId; Layout.fillWidth: true; spacing: Theme.s2
                    PText { Layout.fillWidth: true; text: row.runWhenLoggedOut ? "当前工作区：注销后可继续已有授权任务" : "当前工作区：注销后暂停（默认）"; tone: "secondary" }
                    AButton { objectName: "backgroundPolicy"; label: row.runWhenLoggedOut ? "停用后台运行" : "允许注销后运行"; enabled: row.role === "owner"
                        onConfirmed: shell.hardware("workspaces.runWhenLoggedOut", {workspaceId:row.workspaceId,enabled:!row.runWhenLoggedOut}) }
                }
            }
        }
    }
    PText { text: "工作区"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.workspaces
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: r.implicitHeight + Theme.s3 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin
            RowLayout {
                id: r; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: (row.displayName || row.workspaceId) + (row.workspaceId === shell.workspaceId ? "（当前）" : ""); Layout.fillWidth: true; bold: true }
                PText { text: row.state || ""; tone: "secondary" }
                AButton { label: "切换"; enabled: row.workspaceId !== shell.workspaceId; onConfirmed: shell.switchWorkspace(row.workspaceId) }
                AButton { label: "启动"; writeAction: true; onConfirmed: shell.act("workspaces.start", {workspaceId:row.workspaceId}, "启动工作区") }
                AButton { label: "停止"; variant: "danger"; writeAction: true; onConfirmed: shell.act("workspaces.stop", {workspaceId:row.workspaceId}, "停止工作区") }
                AButton { label: "归档"; variant: "danger"; writeAction: true; onConfirmed: shell.act("workspaces.archive", {workspaceId:row.workspaceId}, "归档工作区") }
            }
        }
    }
    PText { text: "成员"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.members
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: m.implicitHeight + Theme.s3 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin
            RowLayout {
                id: m; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: row.userName || row.userId; Layout.fillWidth: true; bold: true }
                ASelect { label: "工作区角色"; value: row.role || "viewer"
                    options: [{value:"viewer",label:"viewer"},{value:"editor",label:"editor"},{value:"owner",label:"owner"}]
                    onChosen: function(role) { shell.act("members.setRole", {userId:row.userId, role:role, expectedMemberVersion:row.memberVersion}, "设置角色") } }
                AButton { label: "撤销成员"; variant: "danger"; writeAction: true
                    onConfirmed: shell.act("members.revoke", {userId:row.userId, expectedMemberVersion:row.memberVersion}, "撤销成员") }
                AButton { label: "转让所有权"; writeAction: true
                    onConfirmed: shell.act("members.transferOwner", {userId:row.userId, expectedMemberVersion:row.memberVersion, confirm:true}, "转让所有权") }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: machineUsersCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: machineUsersCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s3
            PText { text: "机器用户（管理员操作，经系统可信确认）"; variant: "subhead"; bold: true }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s2
                AField { id: newLogin; objectName: "newUserLogin"; label: "登录名"; Layout.preferredWidth: Theme.px(170) }
                AField { id: newPw; objectName: "newUserPassword"; label: "初始密码"; sensitive: true; Layout.preferredWidth: Theme.px(180) }
                // Machine account type is a separate system concept, not a fourth workspace role.
                ASelect { id: sysRole; label: "机器账户类型"; value: "user"; options: [{value:"user",label:"普通用户"},{value:"admin",label:"管理员"}] }
                AButton { objectName: "createUser"; label: "创建机器用户"; variant: "primary"; writeAction: true
                    enabled: newLogin.boundValue !== "" && newPw.boundValue !== ""
                    onConfirmed: { shell.createUser(newLogin.boundValue,sysRole.currentValue,newPw.boundValue); newPw.boundValue = "" } }
            }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s2
                AField { id: disableId; objectName: "disableUserId"; label: "停用用户 ID"; Layout.preferredWidth: Theme.px(280) }
                AButton { objectName: "disableUser"; label: "停用用户"; variant: "danger"; writeAction: true
                    enabled: disableId.boundValue !== ""; onConfirmed: shell.act("machine.users.disable", {userId:disableId.boundValue}, "停用用户") }
            }
        }
    }
    ActionsList { }
}
