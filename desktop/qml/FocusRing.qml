import QtQuick

Rectangle {
    id: ring
    property Item targetItem: null
    property bool on: false
    property bool hovered: false
    property bool danger: false
    property bool primary: false
    property bool focusOn: on || (targetItem && targetItem.activeFocus) || false
    property int ringRadius: targetItem ? (Theme.radiusControl + Theme.px(2)) : Theme.radiusControl
    property int ringOffset: Theme.px(2)

    anchors.fill: targetItem
    anchors.margins: -ringOffset
    radius: ringRadius
    color: targetItem ? "transparent" : Theme.bgSurface
    border.width: focusOn ? Theme.focusWidth : Theme.borderThin
    border.color: focusOn ? Theme.borderFocus : (danger ? Theme.dangerBorder : (primary ? Theme.accentBorder : (hovered ? Theme.borderStrong : Theme.border)))
    visible: opacity > 0.01
    opacity: !targetItem || focusOn ? 1.0 : 0.0

    Behavior on color {
        ColorAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic }
    }
    Behavior on border.color {
        ColorAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic }
    }
    Behavior on opacity {
        NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic }
    }
}
