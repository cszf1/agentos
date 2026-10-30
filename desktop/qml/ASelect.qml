import QtQuick
import QtQuick.Controls.Basic
// options: [{value, label}] (plain data). currentValue is a string; "" means "default/all" when offered.
ComboBox {
    id: s
    property string label: ""
    property var options: []
    property string value: ""
    signal chosen(string value)
    model: options
    textRole: "label"
    valueRole: "value"
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.ComboBox
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    currentIndex: { for (var i = 0; i < options.length; ++i) if (String(options[i].value) === value) return i; return options.length > 0 ? 0 : -1 }
    onActivated: function(i) { if (i >= 0 && i < options.length) chosen(String(options[i].value)) }
    contentItem: Text {
        leftPadding: 8
        text: s.displayText
        textFormat: Text.PlainText
        font: s.font
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    delegate: ItemDelegate {
        width: s.width
        Accessible.name: modelData.label
        contentItem: Text { text: modelData.label; textFormat: Text.PlainText; font: s.font }
        highlighted: s.highlightedIndex === index
    }
    background: FocusRing { implicitWidth: 160; implicitHeight: 30; on: s.activeFocus; color: "#ffffff" }
}
