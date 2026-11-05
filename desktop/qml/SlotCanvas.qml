import QtQuick
import QtQuick.Controls.Basic
// An app's own area. Clipped: generated content can never draw outside it or over the trusted Shell layers.
Rectangle {
    id: c
    property var view: null
    readonly property real s: (typeof shell !== "undefined" && shell) ? shell.uiScale : 1
    color: Theme.bgSurface
    border.color: Theme.borderStrong
    border.width: Theme.borderThin
    radius: Theme.radiusCard
    clip: true
    implicitHeight: col.implicitHeight + 24
    Accessible.role: Accessible.Grouping
    Accessible.name: view ? ("应用：" + view.title) : "应用"
    Column {
        id: col
        x: 12; y: 12; width: c.width - 24; spacing: 10
        PText { width: parent.width; text: c.view ? c.view.title : ""; variant: "title" }
        PText { width: parent.width; visible: !!c.view && c.view.description !== ""; text: c.view ? c.view.description : ""; variant: "muted" }
        PText { visible: !!c.view && c.view.mode === "loading"; text: "正在加载应用…"; variant: "muted" }
        // error card + version switch entry: never a blank desktop
        Rectangle {
            visible: !!c.view && c.view.mode === "error"
            width: parent.width; implicitHeight: ec.implicitHeight + 20; height: visible ? implicitHeight : 0
            color: Theme.dangerSubtle; border.color: Theme.dangerBorder; border.width: Theme.borderThin; radius: Theme.radiusControl
            Accessible.role: Accessible.AlertMessage; Accessible.name: "无法渲染此应用"
            Column { id: ec; x: 10; y: 10; width: parent.width - 20; spacing: 8
                PText { width: parent.width; text: c.view ? c.view.errorText : "" }
                AButton { objectName: "versionSwitch"; label: "查看并切换版本"; onClicked: if (typeof shell !== "undefined" && shell && c.view) shell.openApp(c.view.appId) } } }
        Rectangle {
            visible: !!c.view && c.view.staleInput
            width: parent.width; implicitHeight: sc.implicitHeight + 16; height: visible ? implicitHeight : 0
            color: Theme.warningSubtle; border.color: Theme.warningBorder; border.width: Theme.borderThin; radius: Theme.radiusControl
            Column { id: sc; x: 8; y: 8; width: parent.width - 16; spacing: 6
                PText { width: parent.width; text: "应用已切换到新版本，你未提交的输入已保留但暂停提交。请按新表单核对后确认。" }
                AButton { label: "按新版本确认"; onClicked: c.view.confirmNewVersion() } } }
        PText {
            width: parent.width
            visible: !!c.view && !!c.view.notice.text
            text: c.view && c.view.notice.text ? c.view.notice.text : ""
            color: c.view && c.view.notice.kind === "error" ? Theme.danger : c.view && c.view.notice.kind === "ok" ? Theme.success : Theme.accent
            Accessible.role: Accessible.StatusBar
        }
        Repeater { model: c.view ? c.view.sourceErrors : []; delegate: PText { width: col.width; text: modelData; color: Theme.danger } }
        SlotNode { visible: !!c.view && c.view.mode === "slot" && c.view.toolbar !== null; node: c.view ? c.view.toolbar : null; view: c.view; width: col.width }
        SlotNode { visible: !!c.view && c.view.mode === "slot"; node: c.view ? c.view.main : null; view: c.view; width: col.width }
        SlotNode { visible: !!c.view && c.view.mode === "slot" && c.view.aside !== null; node: c.view ? c.view.aside : null; view: c.view; width: col.width }
        Loader { active: !!c.view && c.view.mode === "records"; width: col.width; sourceComponent: RecordsView { view: c.view; width: col.width } }
    }
}
