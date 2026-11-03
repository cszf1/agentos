import QtQuick
import QtQuick.Layouts

PageFrame {
    title: "候选提议"
    subtitle: "核对提议内容后批准或拒绝"
    Repeater {
        model: shell.proposals
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: dataCol.implicitHeight + Theme.s4 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border
            ColumnLayout {
                id: dataCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s2
                PText { text: (row.label || row.proposalId) + " — " + row.state; variant: "subhead"; bold: true }
                PText { text: row.reasons || ""; Layout.fillWidth: true; tone: "secondary" }
                PText { text: "指纹：" + (row.proposalHash || ""); mono: true; variant: "caption" }
                RowLayout {
                    AButton { objectName: "acceptProposal"; label: "按此指纹发布"; variant: "primary"; writeAction: true;
                        enabled: row.state === "ready" || row.state === "pending"
                        onConfirmed: shell.act("proposal.accept", {proposalId:row.proposalId, proposalHash:row.proposalHash, baseAppEpoch:row.baseAppEpoch}, "接受提议") }
                    AButton { label: "拒绝"; variant: "danger"; writeAction: true
                        onConfirmed: shell.act("proposal.reject", {proposalId:row.proposalId}, "拒绝提议") }
                }
            }
        }
    }
    PText { visible: shell.proposals.count === 0; text: "没有候选提议"; tone: "muted" }
    ActionsList { prefix: "proposal." }
}
