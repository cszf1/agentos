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
        leftPadding: Theme.px(12)
        rightPadding: Theme.px(28)
        color: Theme.textPrimary
        text: s.displayText
        textFormat: Text.PlainText
        font: s.font
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    indicator: Text {
        x: s.width - width - Theme.px(10)
        y: (s.availableHeight - height) / 2
        text: "▾"
        textFormat: Text.PlainText
        font.family: Theme.fontFamily
        font.pixelSize: Theme.textCaption
        color: Theme.textSecondary
        verticalAlignment: Text.AlignVCenter
    }
    delegate: ItemDelegate {
        id: optDel
        width: s.width
        implicitHeight: Theme.px(34)
        Accessible.name: modelData.label
        highlighted: s.highlightedIndex === index
        contentItem: Text {
            leftPadding: Theme.px(10)
            rightPadding: Theme.px(10)
            color: optDel.highlighted ? Theme.accent : Theme.textPrimary
            text: modelData.label
            textFormat: Text.PlainText
            font.family: s.font.family
            font.pixelSize: s.font.pixelSize
            font.weight: optDel.highlighted ? Font.DemiBold : Font.Normal
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }
        background: Rectangle {
            radius: Theme.radiusSm
            color: optDel.highlighted ? Theme.accentSubtle : (optDel.hovered ? Theme.bgHover : "transparent")
            Behavior on color { ColorAnimation { duration: Theme.animFast } }
        }
    }
    background: FocusRing { implicitWidth: 164; implicitHeight: Theme.px(s.compact ? 32 : 36); on: s.activeFocus; hovered: s.hovered; color: Theme.bgSurface }
}
