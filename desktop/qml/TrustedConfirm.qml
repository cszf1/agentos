import QtQuick
import QtQuick.Controls.Basic
// The trusted system confirmation layer (spec §11, V1-D07). It is a Shell layer above every app canvas; app content
// is clipped to its card and cannot cover it. It shows who/where/what/planHash/version/permission change and the
// unknown-result note; confirming is bound to the identity and epochs it was shown under.
Rectangle {
    id: t
    objectName: "trustedConfirm"
    readonly property var c: (typeof shell !== "undefined" && shell) ? shell.confirm : ({})
    readonly property real s: (typeof shell !== "undefined" && shell) ? shell.uiScale : 1
    visible: !!c.visible
    color: "#cc1b1b1f"
    z: 1000
    focus: visible
    Accessible.role: Accessible.Dialog
    Accessible.name: "AgentOS 系统确认"
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; hoverEnabled: true; onWheel: function(w) { w.accepted = true } }
    onVisibleChanged: if (visible) okBtn.forceActiveFocus()
    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - 40, 640 * t.s)
        implicitHeight: col.implicitHeight + 32
        height: implicitHeight
        radius: 8
        color: "#ffffff"
        border.color: "#1a5fd0"; border.width: 3
        Column {
            id: col
            x: 16; y: 16; width: parent.width - 32; spacing: 6
            PText { text: "AgentOS 系统确认（由系统显示，应用无法修改此框）"; variant: "title" }
            PText { width: parent.width; text: t.c.title || "" ; font.bold: true }
            PText { width: parent.width; text: "用户：" + (t.c.user || "") }
            PText { width: parent.width; text: "工作区：" + (t.c.workspace || "") }
            PText { width: parent.width; text: "资源：" + (t.c.resource || "—") }
            PText { width: parent.width; visible: !!t.c.effect; text: "效果：" + (t.c.effect || "") }
            PText { width: parent.width; text: "计划 hash：" + (t.c.planHash || "—"); font.family: "monospace" }
            PText { width: parent.width; text: "版本/基线：" + (t.c.version || "—") }
            PText { width: parent.width; text: "权限变化：" + (t.c.permissionChange || "") }
            Rectangle { visible: !!t.c.appText; width: parent.width; implicitHeight: at.implicitHeight + 12; height: visible ? implicitHeight : 0; color: "#f4f4f4"; radius: 4
                PText { id: at; x: 6; y: 6; width: parent.width - 12; text: "应用说明（应用提供的文字）：" + (t.c.appText || "") } }
            PText { width: parent.width; text: t.c.unknownNote || ""; variant: "muted" }
            PText { visible: !!t.c.stale; width: parent.width; color: "#a01515"; text: "计划已过期（身份、会话或工作区代次已变化）。请重新生成计划后再确认。" }
            Row { spacing: 10
                AButton { id: okBtn; objectName: "confirmAccept"; label: "确认执行"; variant: "primary"; enabled: !t.c.stale; onClicked: shell.confirmAccept() }
                AButton { objectName: "confirmReject"; label: "取消"; onClicked: shell.confirmReject() } }
        }
    }
    Keys.onEscapePressed: shell.confirmReject()
}
