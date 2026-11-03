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
    contentItem: Text {
        text: c.text
        color: Theme.textPrimary
        textFormat: Text.PlainText
        font: c.font
        leftPadding: c.indicator.width + 6
        verticalAlignment: Text.AlignVCenter
    }
    Rectangle { anchors.fill: parent; color: "transparent"; border.width: c.activeFocus ? 3 : 0; border.color: "#1a5fd0"; radius: 3 }
}
