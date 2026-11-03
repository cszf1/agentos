import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts

Button {
    id: root
    property string label: ""
    property string variant: "secondary"
    property bool enterActivates: true
    property bool askSure: variant === "danger"
    property string iconName: ""
    property bool writeAction: false
    property bool compact: false
    property string disabledReason: ""
    property var shellRef: typeof shell !== "undefined" ? shell : null
    readonly property bool blockedByWriteState: writeAction && shellRef && (shellRef.readOnly || shellRef.writesStopped || shellRef.role === "viewer")
    signal confirmed()
    enabled: !blockedByWriteState
    text: label
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    font.family: Theme.fontFamily
    font.pixelSize: compact ? Theme.textCaption : Theme.textBody
    implicitWidth: Math.max(Theme.px(compact ? 52 : 84), contentItem.implicitWidth + Theme.s3 * 2)
    implicitHeight: Theme.px(compact ? 30 : 36)
    Connections {
        target: root
        function onClicked() {
            if (!root.askSure) { root.confirmed(); return }
            var r = root.parent
            while (r && r.objectName !== "shellRoot") r = r.parent
            if (r) r.askSure(root)
        }
    }
    Keys.onReturnPressed: function(e) { if (enabled && enterActivates) clicked(); e.accepted = true }
    Keys.onEnterPressed: function(e) { if (enabled && enterActivates) clicked(); e.accepted = true }
    contentItem: RowLayout {
        spacing: Theme.s2
        Image {
            visible: root.iconName !== ""
            source: visible ? Theme.iconSource(root.iconName, (root.variant === "secondary" ? Theme.textPrimary : Theme.textOnAccent).toString()) : ""
            sourceSize.width: Theme.iconSm; sourceSize.height: Theme.iconSm
            Layout.preferredWidth: Theme.iconSm; Layout.preferredHeight: Theme.iconSm
        }
        Text {
            text: root.label; textFormat: Text.PlainText; font: root.font
            color: root.variant === "secondary" ? Theme.textPrimary : Theme.textOnAccent
            horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight; Layout.fillWidth: true
        }
    }
    background: Rectangle {
        implicitHeight: Theme.px(36); radius: Theme.radiusControl
        opacity: root.enabled ? 1 : 0.48
        color: root.variant === "danger" ? (root.down || root.hovered ? Theme.dangerHover : Theme.danger)
             : root.variant === "primary" ? (root.down ? Theme.accentPressed : root.hovered ? Theme.accentHover : Theme.accent)
             : root.down ? Theme.bgPressed : root.hovered ? Theme.bgHover : Theme.bgSurface
        border.width: root.activeFocus ? Theme.focusWidth : Theme.borderThin
        border.color: root.activeFocus ? Theme.borderFocus : root.variant === "secondary" ? Theme.borderStrong : color
    }
    ToolTip.visible: hovered && !enabled && (disabledReason !== "" || blockedByWriteState)
    ToolTip.text: disabledReason || "只读或系统暂停写入"
}
