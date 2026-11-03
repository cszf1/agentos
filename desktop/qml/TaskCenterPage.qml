import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "任务中心"
    subtitle: "真实任务、维护作业与异步操作状态"
    PText { text: "运行任务"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.runs
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: r.implicitHeight + Theme.s3 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border
            RowLayout {
                id: r; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                PText { text: row.intent || row.runId; Layout.fillWidth: true }
                PText { text: row.status || row.state || ""; tone: "secondary" }
                AButton { objectName: "cancelRun"; property string runId: row.runId || ""; label: "取消任务"; writeAction: true
                    enabled: ["queued", "running", "accepted", "planning", "building"].indexOf(row.status || row.state) >= 0
                    onConfirmed: shell.act("runs.cancel", {runId:row.runId}, "取消任务") }
                AButton { label: "查看记录"; onConfirmed: shell.loadTranscript(row.runId) }
                AButton { objectName: "compact"; label: "压缩会话"; visible: !!row.conversationId; writeAction: true
                    onConfirmed: shell.act("conversation.compact", {conversationId:row.conversationId}, "压缩会话") }
            }
        }
    }
    PText { text: "维护作业"; variant: "subhead"; bold: true }
    Repeater { model: shell.jobs
        delegate: PText { Layout.fillWidth: true; text: (row.templateId || row.jobId) + " — " + (row.state || ""); tone: "secondary" } }
    PText { text: "系统操作"; variant: "subhead"; bold: true }
    Repeater { model: shell.operations
        delegate: PText { Layout.fillWidth: true; text: (row.actionId || "") + " — " + (row.state || row.phase || ""); tone: "secondary" } }
    AArea { Layout.fillWidth: true; readOnly: true; monospace: true; areaHeight: Theme.px(200); boundValue: shell.transcriptText }
    ActionsList { }
}
