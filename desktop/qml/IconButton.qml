import QtQuick
import QtQuick.Controls.Basic

// A round, borderless icon control. Accessible.name must be set by the user of it.
Button {
    id: ib
    property string iconName: "more"
    property string tone: "secondary"
    focusPolicy: Qt.StrongFocus
    implicitWidth: Theme.px(28); implicitHeight: Theme.px(28)
    padding: 0
    background: Rectangle {
        radius: width / 2
        color: ib.down ? Theme.bgPressed : (ib.hovered ? Theme.bgMuted : "transparent")
        border.width: ib.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
    }
    contentItem: Item {
        Image { anchors.centerIn: parent; source: Theme.iconSource(ib.iconName, ib.tone); sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm }
    }
}
