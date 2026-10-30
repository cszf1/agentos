import QtQuick
import QtQuick.Window
import QtQuick.Controls.Basic
// Fixed built-in health canvas (spec §21.3): no gateway, no user session, no user records. Renders a frame and
// proves keyboard input reaches a text field. Used by the update health agent under a restricted probe environment.
Window {
    id: w
    objectName: "healthWindow"
    width: 640; height: 360; visible: true; color: "#0f172a"
    title: "AgentOS health canvas"
    Column {
        anchors.centerIn: parent; spacing: 12
        Text { textFormat: Text.PlainText; color: "#ffffff"; font.pixelSize: 24; text: "AgentOS 健康画布 · 健康檢查 · health" }
        Rectangle { width: 320; height: 24; radius: 4
            gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#22c55e" } GradientStop { position: 1; color: "#3b82f6" } } }
        TextField { id: probe; objectName: "healthInput"; width: 320; focus: true; placeholderText: "键盘输入探测"; Accessible.name: "键盘输入探测" }
        Text { objectName: "echo"; textFormat: Text.PlainText; color: "#e2e8f0"; text: "输入：" + probe.text }
    }
}
