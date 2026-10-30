import QtQuick
PageFrame {
    title: "任务中心"
    Repeater { model: shell.runs
        delegate: Column { spacing: 2; width: parent ? parent.width : 400
            Row { spacing: 8
                PText { width: 320 * shell.uiScale; text: row.intent || row.runId; elide: Text.ElideRight; maximumLineCount: 1 }
                PText { text: row.status || row.state || ""; width: 90 * shell.uiScale }
                AButton { objectName: "cancelRun"; label: "取消任务"; enabled: ["queued", "running", "accepted", "planning", "building"].indexOf(row.status || row.state) >= 0; onClicked: shell.act("runs.cancel", { runId: row.runId }, "取消任务") }
                AButton { label: "查看记录"; onClicked: shell.loadTranscript(row.runId) }
                AButton { objectName: "compact"; label: "压缩会话"; visible: !!row.conversationId; onClicked: shell.act("conversation.compact", { conversationId: row.conversationId }, "压缩会话") } } } }
    PText { visible: shell.runs.count === 0; text: "没有任务"; variant: "muted" }
    PText { visible: shell.transcriptText !== ""; width: parent.width; text: shell.transcriptText; variant: "small" }
    ActionsList { }
}
