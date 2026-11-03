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
    property string placeholder: ""
    property bool enterSubmits: false
    signal submitted(string value)
    placeholderText: placeholder || label
    echoMode: sensitive ? TextInput.Password : TextInput.Normal
    onTextChanged: if (boundValue !== text) boundValue = text
    onAccepted: if (enterSubmits) submitted(text)
    leftPadding: Theme.s2
    rightPadding: Theme.s2
    focusPolicy: Qt.StrongFocus
    Accessible.name: label
    Accessible.role: Accessible.EditableText
    font.family: Theme.fontFamily
    font.pixelSize: Theme.textBody
    color: Theme.textPrimary
    selectByMouse: true
    onBoundValueChanged: if (text !== boundValue) text = boundValue
    Component.onCompleted: text = boundValue
    onActiveFocusChanged: if (!activeFocus) ime.commit(f)
    ImeGuard { id: ime }
    Connections {
        target: (typeof shell !== "undefined") ? shell : null
        ignoreUnknownSignals: true
        function onScopeCleared(reason) { ime.discard(f); f.boundValue = ""; f.text = "" }
    }
    background: FocusRing { implicitWidth: 200; implicitHeight: Theme.px(36); on: f.activeFocus; color: Theme.bgSurface }
}
