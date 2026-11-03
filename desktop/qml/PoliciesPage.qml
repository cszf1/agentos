import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "维护策略"
    readonly property bool paused: shell.maintenanceState.state === "paused"
    RowLayout {
        PText { text: "自动维护：" + (root.paused ? "已暂停" : (shell.maintenanceState.state || "未知")) }
        AButton { objectName: "maintToggle"; label: root.paused ? "恢复自动维护" : "暂停全部自动维护"
            variant: root.paused ? "primary" : "danger"; writeAction: true
            onConfirmed: shell.act(root.paused ? "maintenance.resume" : "maintenance.pause", {}, root.paused ? "恢复维护" : "暂停维护") }
    }
    Repeater {
        model: shell.policies
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: r.implicitHeight + Theme.s3 * 2
            color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border
            RowLayout {
                id: r; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { Layout.fillWidth: true; text: (row.templateId || "") + " → " + (row.target ? row.target.kind + ":" + row.target.id : "") }
                PText { text: row.state || ""; tone: "secondary" }
                AButton { label: "批准此范围"; enabled: row.state === "pending_approval" || row.state === "draft"; writeAction: true
                    onConfirmed: shell.act("maintenance.policy.approve", {policyId:row.policyId, version:row.version, policyHash:row.policyHash}, "批准策略") }
                AButton { label: "暂停此策略"; writeAction: true
                    onConfirmed: shell.act("maintenance.policy.pause", {policyId:row.policyId}, "暂停策略") }
            }
        }
    }
    PText { text: "维护任务"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.jobs
        delegate: RowLayout {
            Layout.fillWidth: true
            PText { Layout.fillWidth: true; text: (row.templateId || row.jobId) + " — " + (row.state || "") }
            AButton { label: "停止后续步骤"; writeAction: true
                enabled: ["succeeded", "no_change", "failed_no_effect", "cancelled", "expired", "indeterminate", "needs_attention"].indexOf(row.state) < 0
                onConfirmed: shell.act("maintenance.job.cancel", {jobId:row.jobId}, "停止维护任务") }
        }
    }
    Repeater {
        model: shell.maintenanceState.circuits || []
        delegate: RowLayout {
            visible: modelData.state === "open"; Layout.fillWidth: true
            PText { Layout.fillWidth: true; text: "熔断：" + modelData.targetKind + ":" + modelData.targetId; tone: "warning" }
            AButton { label: "处理后重置熔断"; writeAction: true
                onConfirmed: shell.act("maintenance.circuit.reset", {targetKind:modelData.targetKind, targetId:modelData.targetId}, "重置熔断") }
        }
    }
    ActionsList { prefix: "maintenance." }
}
