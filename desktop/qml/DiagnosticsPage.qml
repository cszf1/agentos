import QtQuick
PageFrame {
    title: "运行时诊断"
    Row { spacing: 8
        ASelect { id: scope; label: "诊断范围"; value: "workspace"; options: [{ value: "workspace", label: "当前工作区" }, { value: "machine", label: "整台机器" }] }
        AButton { label: "收集诊断包（默认不含用户正文）"; onClicked: shell.act("diagnostics.collect", { scope: scope.currentValue, redaction: "default" }, "收集诊断") } }
    PText { text: "本地传输：在途 " + shell.transportStats.inflight + "，排队 " + shell.transportStats.queued + "，重连 " + shell.transportStats.reconnects + "，按 ID 查询 " + shell.transportStats.statusQueries + "，事件缺口 " + shell.transportStats.gaps + "，丢弃的过期回应 " + shell.transportStats.lateDropped }
    PText { text: "系统操作"; font.bold: true }
    Repeater { model: shell.operations; delegate: PText { text: (row.actionId || "") + " — " + (row.state || row.phase || "") + " " + (row.effectCertainty || "") } }
    ActionsList { limit: 12 }
}
