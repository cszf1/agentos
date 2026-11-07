import QtQuick
import QtQuick.Controls.Basic

// Text that acts: for the one next step next to a sentence ("连接模型", "查看", "整理").
Button {
    id: l
    property string label: text
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    padding: Theme.px(4)
    leftPadding: Theme.px(6); rightPadding: Theme.px(6)
    background: Rectangle {
        radius: Theme.radiusSm
        color: l.hovered ? Theme.bgMuted : "transparent"
        border.width: l.activeFocus ? Theme.focusWidth : 0
        border.color: Theme.borderFocus
    }
    contentItem: Text {
        text: l.text
        textFormat: Text.PlainText
        font.family: Theme.fontFamily; font.pixelSize: Theme.textBody; font.weight: Font.Medium
        font.underline: l.hovered
        color: l.enabled ? Theme.textPrimary : Theme.textMuted
    }
}
