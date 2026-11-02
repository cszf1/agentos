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
            AButton { label: "停止"; variant: "danger"; onConfirmed: shell.act("workspaces.stop", { workspaceId: row.workspaceId }, "停止工作区") }
            AButton { label: "归档"; variant: "danger"; onConfirmed: shell.act("workspaces.archive", { workspaceId: row.workspaceId }, "归档工作区") } } }
    PText { text: "成员"; font.bold: true }
    Repeater { model: shell.members
        delegate: Row { spacing: 8
            PText { width: 180 * shell.uiScale; text: row.userName || row.userId; elide: Text.ElideRight; maximumLineCount: 1 }
            ASelect { label: "角色 " + (row.userName || row.userId); value: row.role || "viewer"
                      options: [{ value: "owner", label: "所有者" }, { value: "editor", label: "编辑者" }, { value: "viewer", label: "查看者" }]  // the backend roles (machine dir.rs Role)
                      onChosen: function(v) { shell.act("members.setRole", { userId: row.userId, role: v, expectedMemberVersion: row.memberVersion }, "设置角色") } }
            AButton { label: "撤销成员"; variant: "danger"; onConfirmed: shell.act("members.revoke", { userId: row.userId, expectedMemberVersion: row.memberVersion }, "撤销成员") }
            AButton { label: "转让所有权"; onClicked: shell.act("members.transferOwner", { userId: row.userId, expectedMemberVersion: row.memberVersion, confirm: true }, "转让所有权") } } }
    // Machine users (administrators only; the gateway refuses anyone else). Both are machine plans confirmed on the
    // trusted layer with the administrator's own password; the new user's initial password goes only into the create
    // request (machined's one-time secret store).
    PText { text: "机器用户（管理员操作）"; font.bold: true }
    Row { spacing: 8
        AField { id: newLogin; objectName: "newUserLogin"; label: "新用户登录名"; width: 160 * shell.uiScale; placeholderText: "小写字母开头，如 bea" }
        AField { id: newPw; objectName: "newUserPassword"; label: "新用户初始密码"; echoMode: TextInput.Password; sensitive: true; width: 160 * shell.uiScale; placeholderText: "初始密码" }
        ASelect { id: newRole; label: "新用户角色"; value: "user"; options: [{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }] }
        AButton { objectName: "createUser"; label: "创建用户"; enabled: newLogin.text !== "" && newPw.text !== ""
                  onClicked: { shell.createUser(newLogin.text, newRole.currentValue, newPw.text); newPw.text = "" } } }
    Row { spacing: 8
        AField { id: disableId; objectName: "disableUserId"; label: "要停用的用户 ID"; width: 280 * shell.uiScale; placeholderText: "用户 ID" }
        AButton { objectName: "disableUser"; label: "停用用户"; variant: "danger"; enabled: disableId.text !== ""
                  onConfirmed: shell.act("machine.users.disable", { userId: disableId.text }, "停用用户") } }
    ActionsList { prefix: "" }
}
