import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

TabButton {
    id: root

    // Required contract property
    property string label: ""

    // Extended properties
    property bool active: checked
    property string iconName: ""
    property string badge: ""
    property bool fullWidth: false
    text: label
    Accessible.name: label

    implicitWidth: fullWidth ? Theme.px(200) : (row.implicitWidth + Theme.s4)
    implicitHeight: Theme.px(fullWidth ? 30 : 36)
    activeFocusOnTab: true

    background: Rectangle {
        anchors.fill: parent
        radius: Theme.radiusControl
        color: root.active ? Theme.accentSubtle : (root.hovered ? Theme.bgHover : "transparent")
        border.width: root.active ? Theme.borderThin : 0
        border.color: Theme.accentBorder

        Behavior on color {
            ColorAnimation { duration: Theme.animFast }
        }
    }

    // Active left/bottom indicator bar
    Rectangle {
        visible: root.fullWidth || root.active
        width: root.fullWidth ? Theme.px(3) : parent.width - Theme.s3
        height: root.fullWidth ? parent.height - Theme.s2 : Theme.px(2)
        x: root.fullWidth ? 0 : Theme.s2 / 2
        y: root.fullWidth ? Theme.s1 : parent.height - Theme.px(2)
        radius: Theme.px(2)
        color: root.active ? Theme.accent : Theme.textMuted
    }

    FocusRing {
        targetItem: root
        ringRadius: Theme.radiusControl + Theme.px(2)
    }

    contentItem: RowLayout {
        id: row
        anchors.fill: parent
        anchors.leftMargin: Theme.s3
        anchors.rightMargin: Theme.s3
        spacing: Theme.s2

        Image {
            visible: root.iconName !== ""
            source: root.iconName !== "" ? Theme.iconSource(root.iconName, (root.active ? Theme.accent : Theme.textSecondary).toString()) : ""
            sourceSize.width: Theme.iconSm
            sourceSize.height: Theme.iconSm
            Layout.preferredWidth: Theme.iconSm
            Layout.preferredHeight: Theme.iconSm
        }

        PText {
            Layout.fillWidth: root.fullWidth
            text: root.label
            variant: "body"
            bold: root.active
            tone: root.active ? "accent" : "primary"
        }

        Rectangle {
            visible: root.badge !== ""
            implicitWidth: badgeText.implicitWidth + Theme.s2
            implicitHeight: Theme.px(18)
            radius: Theme.px(9)
            color: root.active ? Theme.accent : Theme.bgMuted

            PText {
                id: badgeText
                anchors.centerIn: parent
                text: root.badge
                variant: "caption"
                tone: root.active ? "onAccent" : "secondary"
                bold: true
            }
        }
    }

}
