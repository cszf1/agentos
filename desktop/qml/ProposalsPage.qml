import QtQuick
PageFrame {
    title: "候选提议（proposal）"
    Repeater { model: shell.proposals
        delegate: Column { spacing: 2
            PText { text: (row.label || row.proposalId) + " — " + (row.state || ""); font.bold: true }
            PText { width: 600 * shell.uiScale; text: row.reasons || ""; variant: "small" }
            PText { text: "指纹 " + (row.proposalHash || ""); variant: "small"; font.family: "monospace" }
            Row { spacing: 8
                AButton { objectName: "acceptProposal"; label: "按此指纹发布"; variant: "primary"; enabled: row.state === "ready" || row.state === "pending"; onClicked: shell.act("proposal.accept", { proposalId: row.proposalId, proposalHash: row.proposalHash, baseAppEpoch: row.baseAppEpoch }, "接受提议") }
                AButton { label: "拒绝"; onClicked: shell.act("proposal.reject", { proposalId: row.proposalId }, "拒绝提议") } } } }
    PText { visible: shell.proposals.count === 0; text: "没有候选"; variant: "muted" }
    ActionsList { prefix: "proposal." }
}
