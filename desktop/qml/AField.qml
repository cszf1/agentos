import QtQuick
import QtQuick.Controls.Basic
import AgentOS.Native
// Single-line input. TextInput never interprets markup. An uncommitted composition is committed into THIS field when
// focus moves away, and discarded (never committed) when the scope is cleared (lock / workspace switch / logout).
TextField {
    id: f
    property string label: ""
    property string boundValue: ""
    property bool sensitive: false
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.EditableText
    font.pixelSize: 14 * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    selectByMouse: true
    onBoundValueChanged: if (text !== boundValue) text = boundValue
    Component.onCompleted: text = boundValue
    onActiveFocusChanged: if (!activeFocus) ime.commit(f)
    ImeGuard { id: ime }
    Connections {
        target: (typeof shell !== "undefined") ? shell : null
        ignoreUnknownSignals: true
        function onScopeCleared(reason) { ime.discard(f); f.text = "" }
    }
    background: FocusRing { implicitWidth: 200; implicitHeight: 30; on: f.activeFocus; color: "#ffffff" }
}
