import QtQuick
PageFrame {
    title: "工作区与成员"
    Row { spacing: 8
        AField { id: wsName; label: "新工作区名称"; placeholderText: "新工作区名称"; width: 220 * shell.uiScale }
        AButton { label: "创建工作区"; enabled: wsName.text !== ""; onClicked: shell.act("workspaces.create", { displayName: wsName.text }, "创建工作区 " + wsName.text) } }
    // Owner-only background policy: a real machine plan, never a model action or a simulated hardware control.
    Repeater { model: shell.workspaces
        delegate: Row { visible: row.workspaceId === shell.workspaceId; spacing: 8
            PText { text: row.runWhenLoggedOut ? "当前工作区：注销后可继续已有授权任务" : "当前工作区：注销后暂停（默认）" }
            AButton { objectName: "backgroundPolicy"; label: row.runWhenLoggedOut ? "停用后台运行" : "允许注销后运行"; enabled: row.role === "owner"
                      onClicked: shell.hardware("workspaces.runWhenLoggedOut", { workspaceId: row.workspaceId, enabled: !row.runWhenLoggedOut }) } } }
    Repeater { model: shell.workspaces
        delegate: Row { spacing: 8
            PText { width: 220 * shell.uiScale; text: (row.displayName || row.workspaceId) + (row.workspaceId === shell.workspaceId ? "（当前）" : ""); elide: Text.ElideRight; maximumLineCount: 1 }
            PText { width: 90 * shell.uiScale; text: row.state || "" }
            AButton { label: "切换"; enabled: row.workspaceId !== shell.workspaceId; onClicked: shell.switchWorkspace(row.workspaceId) }
            AButton { label: "启动"; onClicked: shell.act("workspaces.start", { workspaceId: row.workspaceId }, "启动工作区") }
            AButton { label: "停止"; onClicked: shell.act("workspaces.stop", { workspaceId: row.workspaceId }, "停止工作区") }
            AButton { label: "归档"; variant: "danger"; onClicked: shell.act("workspaces.archive", { workspaceId: row.workspaceId }, "归档工作区") } } }
    PText { text: "成员"; font.bold: true }
    Repeater { model: shell.members
        delegate: Row { spacing: 8
            PText { width: 180 * shell.uiScale; text: row.userName || row.userId; elide: Text.ElideRight; maximumLineCount: 1 }
            ASelect { label: "角色 " + (row.userName || row.userId); value: row.role || "viewer"
                      options: [{ value: "owner", label: "所有者" }, { value: "editor", label: "编辑者" }, { value: "operator", label: "操作员" }, { value: "viewer", label: "只读" }]
                      onChosen: function(v) { shell.act("members.setRole", { userId: row.userId, role: v, expectedMemberVersion: row.memberVersion }, "设置角色") } }
            AButton { label: "撤销成员"; variant: "danger"; onClicked: shell.act("members.revoke", { userId: row.userId, expectedMemberVersion: row.memberVersion }, "撤销成员") }
            AButton { label: "转让所有权"; onClicked: shell.act("members.transferOwner", { userId: row.userId, expectedMemberVersion: row.memberVersion, confirm: true }, "转让所有权") } } }
    ActionsList { prefix: "" }
}
