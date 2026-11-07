import QtQuick
import QtQuick.Controls.Basic

Button {
    id: it
    property string label: ""
    property string iconName: ""
    property bool active: false
    property bool badge: false
    text: label
    Accessible.name: label
    focusPolicy: Qt.StrongFocus
    padding: 0
    implicitWidth: Theme.dockItem
    implicitHeight: Theme.dockItem
    ToolTip.visible: hovered
    ToolTip.delay: 500
    ToolTip.text: label
    background: Rectangle {
        radius: Theme.px(12)
        color: it.active ? Theme.bgMuted : (it.down ? Theme.bgPressed : (it.hovered ? Theme.bgHover : Theme.bgSurface))
        border.width: it.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
        Behavior on color { ColorAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic } }
    }
    contentItem: Item {
        Image {
            anchors.centerIn: parent
            source: Theme.iconSource(it.iconName, it.active ? "primary" : "secondary")
            sourceSize.width: Theme.iconMd; sourceSize.height: Theme.iconMd
        }
        // the current place: a small ink dot; work in progress: a dot top-right
        Rectangle {
            visible: it.active
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: Theme.px(4)
            width: Theme.px(4); height: Theme.px(4); radius: Theme.px(2)
            color: Theme.accent
        }
        Rectangle {
            visible: it.badge
            anchors.right: parent.right; anchors.top: parent.top
            anchors.rightMargin: Theme.px(6); anchors.topMargin: Theme.px(6)
            width: Theme.px(7); height: Theme.px(7); radius: Theme.px(4)
            color: Theme.accent
        }
    }
}
