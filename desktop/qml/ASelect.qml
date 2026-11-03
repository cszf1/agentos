import QtQuick
import QtQuick.Controls.Basic
// options: [{value, label}] (plain data). currentValue is a string; "" means "default/all" when offered.
ComboBox {
    id: s
    property string label: ""
    property var options: []
    property string value: ""
    property bool compact: false
    signal chosen(string value)
    model: options
    textRole: "label"
    valueRole: "value"
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.ComboBox
    font.family: Theme.fontFamily
    font.pixelSize: Theme.textBody
    palette.text: Theme.textPrimary
    currentIndex: { for (var i = 0; i < options.length; ++i) if (String(options[i].value) === value) return i; return options.length > 0 ? 0 : -1 }
    onActivated: function(i) { if (i >= 0 && i < options.length) chosen(String(options[i].value)) }
    contentItem: Text {
        leftPadding: 8
        color: Theme.textPrimary
        text: s.displayText
        textFormat: Text.PlainText
        font: s.font
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    delegate: ItemDelegate {
        width: s.width
        Accessible.name: modelData.label
        contentItem: Text { color: Theme.textPrimary; text: modelData.label; textFormat: Text.PlainText; font: s.font }
        highlighted: s.highlightedIndex === index
    }
    background: FocusRing { implicitWidth: 160; implicitHeight: Theme.px(36); on: s.activeFocus; color: Theme.bgSurface }
}
