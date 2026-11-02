import QtQuick
// System update (spec §13), in the update job's own fields and state names (machine release.rs UPDATE_EDGES): an open
// job is {updateId, state, fromReleaseId, toReleaseId, target}; no job is {updateId: null, state: "none"}. Activation
// is the administrator action admin.update {step: "activate"}: danger dialog, then the trusted layer with the
// administrator's password (gateway PAM + one-time ticket).
PageFrame {
    title: "系统更新"
    readonly property var u: shell.updateStatus
    readonly property var stateText: ({ none: "没有进行中的更新", discovered: "已发现", verified: "已验证", downloading: "下载中", staged: "已就绪，可以激活",
        waiting_confirmation: "等待确认", quiescing: "正在暂停工作区", armed: "等待重启试启动", trial_boot: "试启动中", validating: "验证中",
        committed: "已完成", rollback_pending: "正在回滚", rolled_back: "已回滚", needs_attention: "需要处理", failed_no_switch: "失败，未切换", cancelled: "已取消" })
    // update activate accepts these states (machine ctl.rs update_activate)
    readonly property bool activatable: !!u.updateId && ["staged", "waiting_confirmation", "quiescing"].indexOf(u.state) >= 0
    readonly property var target: u.target || ({})
    PText { objectName: "updateSummary"
            text: "当前：" + (u.fromReleaseId || "未知") + "    候选：" + (u.toReleaseId || "无") + "    状态：" + (stateText[u.state || "none"] || u.state) }
    PText { visible: !!u.error; text: u.error ? (u.error.code || "") : ""; color: "#a01515" }
    Row { spacing: 8
        AButton { label: "检查更新"; onClicked: shell.act("updates.check", {}, "检查更新") }
        AButton { label: "准备更新"; enabled: !!target.releaseId; onClicked: shell.act("updates.prepare", { releaseId: target.releaseId, manifestHash: target.manifestHash }, "准备更新") }
        AButton { objectName: "updateActivate"; label: "重启并试启动"; variant: "danger"; enabled: activatable
                  onConfirmed: shell.hardware("admin.update", { step: "activate", updateId: u.updateId }) }
        AButton { label: "取消"; enabled: !!u.toReleaseId; onClicked: shell.act("updates.cancel", { releaseId: u.toReleaseId || "" }, "取消更新") } }
    ActionsList { prefix: "" }
}
