import QtQuick
Rectangle {
    property bool on: false
    property bool danger: false
    property bool primary: false
    radius: 4
    color: primary ? "#dce7fb" : danger ? "#fbe3e3" : "#f4f4f4"
    border.width: on ? 3 : 1
    border.color: on ? "#1a5fd0" : "#9a9a9a"
}
