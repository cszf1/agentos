import QtQuick
import QtQuick.Controls.Basic
CheckBox {
    id: c
    property string label: ""
    text: label
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.CheckBox
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    contentItem: Text {
        text: c.text
        textFormat: Text.PlainText
        font: c.font
        leftPadding: c.indicator.width + 6
        verticalAlignment: Text.AlignVCenter
    }
    Rectangle { anchors.fill: parent; color: "transparent"; border.width: c.activeFocus ? 3 : 0; border.color: "#1a5fd0"; radius: 3 }
}
