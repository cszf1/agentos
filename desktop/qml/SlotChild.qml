import QtQuick
// Recursion point of the fixed renderer: always loads the fixed SlotNode.qml from the same qrc directory.
Loader {
    id: l
    property var n: null
    property var v: null
    source: "SlotNode.qml"
    onLoaded: { item.node = Qt.binding(function() { return l.n }); item.view = Qt.binding(function() { return l.v }) }
}
