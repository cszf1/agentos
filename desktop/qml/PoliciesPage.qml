import QtQuick
PageFrame {
    title: "维护策略"
    readonly property bool paused: shell.maintenanceState.state === "paused"
    Row { spacing: 8
        PText { text: "自动维护：" + (paused ? "已暂停" : (shell.maintenanceState.state || "未知")) }
        AButton { objectName: "maintToggle"; label: paused ? "恢复自动维护" : "暂停全部自动维护"; variant: paused ? "primary" : "danger"; onClicked: shell.act(paused ? "maintenance.resume" : "maintenance.pause", {}, paused ? "恢复维护" : "暂停维护") } }
    Repeater { model: shell.policies
        delegate: Row { spacing: 8
            PText { width: 260 * shell.uiScale; text: (row.templateId || "") + " → " + (row.target ? row.target.kind + ":" + row.target.id : ""); elide: Text.ElideRight; maximumLineCount: 1 }
            PText { text: row.state || "" }
            AButton { label: "批准此范围"; enabled: row.state === "pending_approval" || row.state === "draft"; onClicked: shell.act("maintenance.policy.approve", { policyId: row.policyId, version: row.version, policyHash: row.policyHash }, "批准策略") }
            AButton { label: "暂停此策略"; onClicked: shell.act("maintenance.policy.pause", { policyId: row.policyId }, "暂停策略") } } }
    PText { text: "维护任务"; font.bold: true }
    Repeater { model: shell.jobs
        delegate: Row { spacing: 8
            PText { width: 260 * shell.uiScale; text: (row.templateId || row.jobId) + " — " + (row.state || ""); elide: Text.ElideRight; maximumLineCount: 1 }
            AButton { label: "停止后续步骤"; enabled: ["succeeded", "no_change", "failed_no_effect", "cancelled", "expired", "indeterminate", "needs_attention"].indexOf(row.state) < 0; onClicked: shell.act("maintenance.job.cancel", { jobId: row.jobId }, "停止维护任务") } } }
    Repeater { model: shell.maintenanceState.circuits || []
        delegate: Row { spacing: 8; visible: modelData.state === "open"
            PText { text: "熔断：" + modelData.targetKind + ":" + modelData.targetId }
            AButton { label: "我已处理，重新允许恢复"; onClicked: shell.act("maintenance.circuit.reset", { targetKind: modelData.targetKind, targetId: modelData.targetId }, "重置熔断") } } }
    ActionsList { prefix: "maintenance." }
}
