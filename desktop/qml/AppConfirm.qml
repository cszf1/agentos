import QtQuick
import QtQuick.Controls.Basic
// An app's own confirmation question (the app's confirm step). It is an ordinary dialog: no system header, no system
// colours, below the trusted system layer, and it says the text comes from the app, so an app can never pass its
// question off as a system approval. Focus starts on 拒绝; the answer only resumes the app's own action.
Rectangle {
    id: a
    objectName: "appConfirm"
    readonly property var c: (typeof shell !== "undefined" && shell) ? shell.appConfirm : ({})
    readonly property real s: (typeof shell !== "undefined" && shell) ? shell.uiScale : 1
    visible: !!c.visible
    color: "#66000000"
    z: 800
    focus: visible
    Accessible.role: Accessible.Dialog
    Accessible.name: "应用请求确认"
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; hoverEnabled: true; onWheel: function(w) { w.accepted = true } }
    onVisibleChanged: if (visible) Qt.callLater(function() { noBtn.forceActiveFocus() })  // after `focus: visible`
    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - 40, 520 * a.s)
        height: col.implicitHeight + 32
        radius: 8
        color: "#ffffff"
        border.color: "#c8c8c8"; border.width: 1
        Column {
            id: col
            x: 16; y: 16; width: parent.width - 32; spacing: 8
            PText { width: parent.width; text: "「" + (a.c.app || "应用") + "」请求确认"; variant: "title" }
            PText { objectName: "appConfirmText"; width: parent.width; text: a.c.text || "" }
            PText { width: parent.width; variant: "muted"; text: "以上文字由应用提供，不是系统确认，也不会改变任何权限。" }
            Row { spacing: 10
                AButton { objectName: "appConfirmAccept"; label: "继续"; onClicked: shell.appConfirmAnswer(true) }
                AButton { id: noBtn; objectName: "appConfirmReject"; label: "拒绝"; onClicked: shell.appConfirmAnswer(false) } }
        }
    }
    Keys.onEscapePressed: shell.appConfirmAnswer(false)
}
