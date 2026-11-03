import QtQuick
import QtQuick.Layouts

PageFrame {
    title: "运行时诊断"
    subtitle: "查看连接状态、系统操作与诊断日志"
    RowLayout {
        ASelect { id: scope; label: "诊断范围"; value: "workspace"; options: [
            {value:"workspace",label:"当前工作区"},{value:"machine",label:"整台机器"}] }
        AButton { label: "收集诊断包（默认不含用户正文）"; writeAction: true
            onConfirmed: shell.act("diagnostics.collect", {scope:scope.currentValue, redaction:"default"}, "收集诊断") }
    }
    Rectangle {
        Layout.fillWidth: true; implicitHeight: stateCol.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border
        ColumnLayout {
            id: stateCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s2
            PText { text: "传输状态"; variant: "subhead"; bold: true }
            PText { text: "在途 " + shell.transportStats.inflight + " · 排队 " + shell.transportStats.queued + " · 重连 " + shell.transportStats.reconnects + " · 状态查询 " + shell.transportStats.statusQueries }
            PText { text: "事件缺口 " + shell.transportStats.gaps + " · 丢弃过期回应 " + shell.transportStats.lateDropped; tone: "secondary" }
        }
    }
    PText { text: "系统操作"; variant: "subhead"; bold: true }
    Repeater { model: shell.operations
        delegate: PText { text: (row.actionId || "") + " — " + (row.state || row.phase || "") + " " + (row.effectCertainty || "") } }
    AArea { Layout.fillWidth: true; label: "诊断日志"; readOnly: true; monospace: true; areaHeight: Theme.px(280); boundValue: shell.diagnosticsText }
    ActionsList { limit: 12 }
}
