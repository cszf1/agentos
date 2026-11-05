import QtQuick
import QtQuick.Controls.Basic
CheckBox {
    id: c
    property string label: ""
    property bool writeAction: false
    property var shellRef: typeof shell !== "undefined" ? shell : null
    enabled: !(writeAction && shellRef && (shellRef.readOnly || shellRef.writesStopped || shellRef.role === "viewer"))
    text: label
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.CheckBox
    font.family: Theme.fontFamily
    font.pixelSize: Theme.textBody
    palette.text: Theme.textPrimary
    spacing: Theme.s2
    indicator: Rectangle {
        implicitWidth: Theme.px(18)
        implicitHeight: Theme.px(18)
        x: c.leftPadding
        y: parent.height / 2 - height / 2
        radius: Theme.radiusSm
        color: c.checked ? Theme.accent : (c.hovered ? Theme.bgHover : Theme.bgSurface)
        border.width: c.activeFocus ? Theme.focusWidth : Theme.borderThin
        border.color: c.activeFocus ? Theme.borderFocus : (c.checked ? Theme.accent : Theme.borderStrong)
        Behavior on color { ColorAnimation { duration: Theme.animFast } }
        Behavior on border.color { ColorAnimation { duration: Theme.animFast } }
        Text {
            anchors.centerIn: parent
            visible: c.checked
            text: "✓"
            textFormat: Text.PlainText
            font.family: Theme.fontFamily
            font.pixelSize: Theme.textCaption
            font.bold: true
            color: Theme.textOnAccent
        }
    }
    contentItem: Text {
        text: c.text
        color: Theme.textPrimary
        textFormat: Text.PlainText
        font: c.font
        leftPadding: c.indicator.width + Theme.s2
        verticalAlignment: Text.AlignVCenter
    }
    background: Rectangle {
        property bool on: c.activeFocus
        anchors.fill: parent
        color: "transparent"
        border.width: c.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
        radius: Theme.radiusSm
    }
}
