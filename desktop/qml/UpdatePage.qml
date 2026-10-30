import QtQuick
PageFrame {
    title: "系统更新"
    readonly property var u: shell.updateStatus
    PText { text: "当前：" + (u.current || "未知") + "    候选：" + (u.candidate ? (u.candidate.releaseId || u.candidate) : "无") + "    状态：" + (u.state || "空闲") }
    PText { visible: !!u.error; text: u.error ? (u.error.code || "") : ""; color: "#a01515" }
    Row { spacing: 8
        AButton { label: "检查更新"; onClicked: shell.act("updates.check", {}, "检查更新") }
        AButton { label: "准备更新"; enabled: !!u.candidate; onClicked: shell.act("updates.prepare", { releaseId: u.candidate.releaseId, manifestHash: u.candidate.manifestHash }, "准备更新") }
        AButton { label: "重启并试启动"; variant: "danger"; enabled: u.state === "prepared"; onClicked: shell.act("updates.activate", { releaseId: u.candidate.releaseId }, "激活更新") }
        AButton { label: "取消"; enabled: !!u.candidate; onClicked: shell.act("updates.cancel", { releaseId: u.candidate ? u.candidate.releaseId : "" }, "取消更新") } }
    ActionsList { prefix: "updates." }
}
