import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts

// A row in a menu or list: icon, label, a quiet hint on the right.
Button {
    id: r
    property string label: ""
    property string iconName: ""
    property string hint: ""
    property bool active: false
    text: label
    Accessible.name: label
    focusPolicy: Qt.StrongFocus
    Layout.fillWidth: true
    implicitHeight: Theme.px(34)
    padding: 0
    background: Rectangle {
        radius: Theme.radiusControl
        color: r.active ? Theme.bgMuted : (r.down ? Theme.bgPressed : (r.hovered ? Theme.bgHover : "transparent"))
        border.width: r.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
        Behavior on color { ColorAnimation { duration: Theme.animFast } }
    }
    contentItem: RowLayout {
        spacing: Theme.s2
        Item { implicitWidth: Theme.px(2) }
        Image {
            visible: r.iconName !== ""
            source: visible ? Theme.iconSource(r.iconName, r.active ? "primary" : "secondary") : ""
            sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm
            Layout.preferredWidth: Theme.iconSm; Layout.preferredHeight: Theme.iconSm
        }
        PText { text: r.label; Layout.fillWidth: true; bold: r.active; wrapMode: Text.NoWrap; elide: Text.ElideRight }
        PText { visible: r.hint !== ""; text: r.hint; variant: "caption"; tone: "muted"; wrapMode: Text.NoWrap }
        Item { implicitWidth: Theme.px(4) }
    }
}
