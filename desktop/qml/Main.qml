import QtQuick
import QtQuick.Window
import "Strings.js" as Strings

Window {
    id: mainWindow
    visible: true
    width: 1280
    height: 800
    minimumWidth: 1024
    minimumHeight: 640
    title: Strings.app.title + " — " + shell.workspaceName
    color: Theme.bgApp

    objectName: "mainWindow"
    Connections { target: shell
        function onUiScaleChanged() { Theme.scale = shell.uiScale }
    }
    Component.onCompleted: Theme.scale = shell.uiScale

    ShellRoot {
        objectName: "shellRoot"
        anchors.fill: parent
    }
}
