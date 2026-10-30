import QtQuick
import QtQuick.Window
Window {
    id: w
    objectName: "mainWindow"
    width: 1280; height: 800
    visible: true
    color: "#ffffff"
    title: "AgentOS"
    ShellRoot { anchors.fill: parent }
}
