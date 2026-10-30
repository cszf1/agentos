import QtQuick
import QtQuick.Controls.Basic
// Common page scaffold: title, cache timestamp when the Host is unavailable, scrollable content column.
Flickable {
    id: pf
    property string title: ""
    default property alias content: body.data
    contentWidth: width
    contentHeight: body.implicitHeight + 80
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { }
    Accessible.role: Accessible.Pane
    Accessible.name: title
    Column {
        id: head
        x: 16; y: 12; width: pf.width - 32; spacing: 4
        PText { text: pf.title; variant: "title" }
        PText { visible: shell.readOnly && shell.cachedAt !== ""; text: "缓存内容，更新于 " + shell.cachedAt + "（不是当前事实）"; color: "#7a5a00"; variant: "small" }
    }
    Column { id: body; x: 16; y: head.y + head.height + 10; width: pf.width - 32; spacing: 10 }
}
