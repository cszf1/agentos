import QtQuick
import QtQuick.Layouts

// The dock: four fixed places. Settings holds every system page.
// Geometry is part of the VM pixel checks (os/tests m5/m19/m20): a surface-coloured box with dockPad around
// equal dockItem squares dockGap apart; the current one is filled bgMuted. Keep them in step.
Rectangle {
    id: dock
    objectName: "dock"
    property var shellRoot: null
    readonly property string page: shellRoot ? shellRoot.page : "home"
    width: row.implicitWidth + Theme.dockPad * 2
    height: Theme.dockHeight
    radius: Theme.px(18)
    color: Theme.bgSurface
    border.width: Theme.borderThin
    border.color: Theme.border

    Row {
        id: row
        anchors.centerIn: parent
        spacing: Theme.dockGap
        DockItem { objectName: "nav:home"; label: "桌面"; iconName: "home"; active: dock.page === "home"; onClicked: dock.shellRoot.go("home") }
        DockItem { objectName: "nav:app"; label: "应用"; iconName: "apps"; active: dock.page === "app"; onClicked: dock.shellRoot.go("app") }
        DockItem { objectName: "nav:tasks"; label: "任务"; iconName: "tasks"; active: dock.page === "tasks"
            badge: { var n = 0; if (typeof shell === "undefined") return false; for (var i = 0; i < shell.runs.count; ++i) { var r = shell.runs.get(i); if (["queued", "running", "accepted", "planning", "building"].indexOf(r.status || r.state) >= 0) ++n } return n > 0 }
            onClicked: dock.shellRoot.go("tasks") }
        DockItem { objectName: "nav:settings"; label: "设置"; iconName: "settings"; active: dock.shellRoot ? dock.shellRoot.inSettings : false; onClicked: dock.shellRoot.openSettings() }
    }
}
