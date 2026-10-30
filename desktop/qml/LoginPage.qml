import QtQuick
PageFrame {
    title: "登录与首次设置"
    PText { text: "网关连接：" + (shell.connected ? "已连接" : "未连接（正在重连）") }
    PText { text: "会话：" + (shell.sessionBound ? ("已绑定 " + shell.userName + "（" + shell.role + "）") : "未绑定") + (shell.locked ? "，已锁定" : "") }
    PText { text: "会话代次：" + shell.sessionEpoch; variant: "small" }
    PText { width: parent.width; variant: "muted"; text: "登录由 greetd/PAM 完成；本页只显示会话绑定与首次设置状态，不接收密码。" }
    PText { text: "首次设置：" + (shell.setupStatus.state || "无需设置"); font.bold: true }
    Repeater { model: shell.setupStatus.steps || []; delegate: PText { text: (modelData.title || modelData.id || "") + " — " + (modelData.state || "") } }
    Row { spacing: 8
        AButton { label: "重新连接"; onClicked: shell.reconnect() }
        AButton { label: "重新绑定会话"; onClicked: shell.rebind() } }
}
