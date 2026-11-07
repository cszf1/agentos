import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts

// A borderless top-bar control: an icon, a short text, a status dot or a count.
Button {
    id: b
    property string iconName: ""
    property color dotColor: "transparent"
    property string badge: ""
    property bool active: false
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    implicitHeight: Theme.px(26)
    implicitWidth: row.implicitWidth + Theme.px(text !== "" ? 20 : 10)
    background: Rectangle {
        radius: Theme.radiusPill
        color: b.down ? Theme.bgPressed : (b.hovered || b.active ? Theme.bgMuted : "transparent")
        border.width: b.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
        Behavior on color { ColorAnimation { duration: Theme.animFast } }
    }
    contentItem: Item {
        implicitWidth: row.implicitWidth
        implicitHeight: row.implicitHeight
        RowLayout {
            id: row
            anchors.centerIn: parent
            spacing: Theme.px(6)
            Rectangle {
                visible: b.dotColor.a > 0
                width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3)
                color: b.dotColor
            }
            Image {
                visible: b.iconName !== ""
                source: visible ? Theme.iconSource(b.iconName, "secondary") : ""
                sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm
                Layout.preferredWidth: Theme.iconSm; Layout.preferredHeight: Theme.iconSm
            }
            Text {
                visible: b.text !== ""
                text: b.text
                textFormat: Text.PlainText
                font.family: Theme.fontFamily; font.pixelSize: Theme.textCaption
                color: Theme.textSecondary
            }
            Rectangle {
                visible: b.badge !== ""
                implicitWidth: Math.max(Theme.px(16), badgeText.implicitWidth + Theme.px(8))
                implicitHeight: Theme.px(16)
                radius: Theme.px(8)
                color: Theme.accent
                Text {
                    id: badgeText
                    anchors.centerIn: parent
                    text: b.badge
                    textFormat: Text.PlainText
                    font.family: Theme.fontFamily; font.pixelSize: Theme.px(10); font.weight: Font.DemiBold
                    color: Theme.textOnAccent
                }
            }
        }
    }
}
