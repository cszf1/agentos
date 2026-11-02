import QtQuick
import QtQuick.Controls.Basic
Button {
    id: b
    property string label: ""
    property string variant: "secondary"
    // false on the trusted layer's accept button: Enter must never confirm a system plan (product decision)
    property bool enterActivates: true
    text: label
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.Button
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    contentItem: Text {
        text: b.text
        textFormat: Text.PlainText
        font: b.font
        color: b.enabled ? (b.variant === "danger" ? "#a01515" : "#1f1f1f") : "#8a8a8a"
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    background: FocusRing { implicitWidth: 64; implicitHeight: 30; on: b.activeFocus; danger: b.variant === "danger"; primary: b.variant === "primary" }
    Keys.onReturnPressed: if (enabled && enterActivates) clicked()
    Keys.onEnterPressed: if (enabled && enterActivates) clicked()
}
