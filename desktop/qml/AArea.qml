import QtQuick
import QtQuick.Controls.Basic
import AgentOS.Native
TextArea {
    id: a
    property string label: ""
    property string boundValue: ""
    textFormat: TextEdit.PlainText
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.EditableText
    wrapMode: TextEdit.Wrap
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    onBoundValueChanged: if (text !== boundValue) text = boundValue
    Component.onCompleted: text = boundValue
    onActiveFocusChanged: if (!activeFocus) ime.commit(a)
    ImeGuard { id: ime }
    // Tab moves focus (keyboard-only operation) instead of inserting a tab character.
    Keys.onTabPressed: function(e) { var n = a.nextItemInFocusChain(true); if (n) n.forceActiveFocus(Qt.TabFocusReason); e.accepted = true }
    Keys.onBacktabPressed: function(e) { var n = a.nextItemInFocusChain(false); if (n) n.forceActiveFocus(Qt.BacktabFocusReason); e.accepted = true }
    Connections {
        target: (typeof shell !== "undefined") ? shell : null
        ignoreUnknownSignals: true
        function onScopeCleared(reason) { ime.discard(a); a.text = "" }
    }
    background: FocusRing { implicitWidth: 240; implicitHeight: 72; on: a.activeFocus; color: "#ffffff" }
}
