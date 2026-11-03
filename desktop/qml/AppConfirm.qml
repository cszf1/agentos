import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts

// Ordinary application question: never styled as trusted system confirmation.
FocusScope {
    id: root
    objectName: "appConfirm"
    property var shellRef: typeof shell !== "undefined" ? shell : null
    readonly property var c: shellRef ? shellRef.appConfirm : ({})
    readonly property bool isOpen: !!c.visible
    anchors.fill: parent; visible: isOpen; z: 800; focus: visible
    Accessible.role: Accessible.Dialog
    Accessible.name: "应用请求确认"
    onIsOpenChanged: if (isOpen) Qt.callLater(function() { reject.forceActiveFocus() })
    Keys.onEscapePressed: if (root.shellRef) root.shellRef.appConfirmAnswer(false)
    Rectangle {
        anchors.fill: parent; color: Theme.scrimModal
        MouseArea { anchors.fill: parent; onClicked: if (root.shellRef) root.shellRef.appConfirmAnswer(false) }
    }
    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - Theme.s6, Theme.px(510))
        height: content.implicitHeight + Theme.s5 * 2
        radius: Theme.radiusModal; color: Theme.bgSurface
        border.width: Theme.borderThin; border.color: Theme.borderStrong
        ColumnLayout {
            id: content
            anchors.fill: parent; anchors.margins: Theme.s5; spacing: Theme.s3
            PText { text: "「" + (root.c.app || "应用") + "」请求确认"; variant: "title"; bold: true }
            PText { objectName: "appConfirmText"; Layout.fillWidth: true; text: root.c.text || "" }
            PText { Layout.fillWidth: true; variant: "caption"; tone: "muted"; text: "以上文字来自应用，不是系统确认，也不授予系统权限。" }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s3
                AButton { id: reject; objectName: "appConfirmReject"; label: "拒绝"; onConfirmed: if (root.shellRef) root.shellRef.appConfirmAnswer(false) }
                Item { Layout.fillWidth: true }
                AButton { objectName: "appConfirmAccept"; label: "继续"; variant: "primary"; onConfirmed: if (root.shellRef) root.shellRef.appConfirmAnswer(true) }
            }
        }
    }
}
