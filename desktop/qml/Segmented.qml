import QtQuick
import QtQuick.Controls.Basic

// Two or three mutually exclusive choices in one quiet track.
Rectangle {
    id: seg
    property var options: []
    property string value: ""
    signal chosen(string value)
    implicitWidth: row.implicitWidth + Theme.px(4)
    implicitHeight: Theme.px(30)
    radius: Theme.radiusControl
    color: Theme.bgMuted
    Row {
        id: row
        anchors.centerIn: parent
        spacing: Theme.px(2)
        Repeater {
            model: seg.options
            delegate: Button {
                id: opt
                required property var modelData
                text: modelData.label
                Accessible.name: modelData.label
                focusPolicy: Qt.StrongFocus
                implicitHeight: Theme.px(26)
                implicitWidth: Math.max(Theme.px(52), lbl.implicitWidth + Theme.px(20))
                padding: 0
                onClicked: seg.chosen(String(modelData.value))
                background: Rectangle {
                    radius: Theme.radiusControl - Theme.px(2)
                    color: String(opt.modelData.value) === seg.value ? Theme.bgSurface : "transparent"
                    border.width: opt.activeFocus ? Theme.focusWidth : 0
                    border.color: Theme.borderFocus
                }
                contentItem: Text {
                    id: lbl
                    text: opt.modelData.label
                    textFormat: Text.PlainText
                    horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
                    font.family: Theme.fontFamily; font.pixelSize: Theme.textCaption
                    font.weight: String(opt.modelData.value) === seg.value ? Font.DemiBold : Font.Normal
                    color: String(opt.modelData.value) === seg.value ? Theme.textPrimary : Theme.textSecondary
                }
            }
        }
    }
}
