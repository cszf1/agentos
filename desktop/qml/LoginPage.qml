import QtQuick
import QtQuick.Layouts

PageFrame {
    title: "账户与会话"
    subtitle: "当前登录会话与首次设置的状态"
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: sessionCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: sessionCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s2
            PText { text: "会话与网关状态"; variant: "subhead"; bold: true }
            PText { text: "网关连接：" + (shell.connected ? "已连接" : "未连接（正在重连）"); tone: shell.connected ? "success" : "danger" }
            PText { text: "会话：" + (shell.sessionBound ? ("已绑定 " + shell.userName + "（" + shell.role + "）") : "未绑定") + (shell.locked ? "，已锁定" : "") }
            PText { text: "会话代次：" + shell.sessionEpoch; variant: "small"; mono: true }
            PText { Layout.fillWidth: true; variant: "muted"; text: "登录由 greetd/PAM 完成；本页只显示会话绑定与首次设置状态，不接收密码。" }
            RowLayout {
                spacing: Theme.s2
                Layout.topMargin: Theme.s1
                AButton { label: "重新连接"; variant: "primary"; onConfirmed: shell.reconnect() }
                AButton { label: "重新绑定会话"; onConfirmed: shell.rebind() }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: setupCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: setupCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s2
            PText { text: "首次设置：" + (shell.setupStatus.state || "无需设置"); variant: "subhead"; bold: true }
            Repeater {
                model: shell.setupStatus.steps || []
                delegate: PText {
                    Layout.fillWidth: true
                    text: (modelData.title || modelData.id || "") + " — " + (modelData.state || "")
                    tone: "secondary"
                }
            }
        }
    }
}
