import QtQuick
import QtQuick.Controls.Basic
TabButton {
    id: t
    property string label: ""
    text: label
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.PageTab
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    contentItem: Text { text: t.text; textFormat: Text.PlainText; font: t.font; horizontalAlignment: Text.AlignHCenter; color: t.checked ? "#1a5fd0" : "#333333" }
    background: FocusRing { implicitHeight: 30; on: t.activeFocus; primary: t.checked }
}
