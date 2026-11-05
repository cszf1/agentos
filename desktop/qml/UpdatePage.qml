import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "系统更新"
    subtitle: "A/B 原子更新、试启动与自动回滚状态"
    readonly property var u: shell.updateStatus
    readonly property var stateText: ({ none: "没有进行中的更新", discovered: "已发现", verified: "已验证", downloading: "下载中", staged: "已就绪，可以激活",
        waiting_confirmation: "等待确认", quiescing: "正在暂停工作区", armed: "等待重启试启动", trial_boot: "试启动中", validating: "验证中",
        committed: "已完成", rollback_pending: "正在回滚", rolled_back: "已回滚", needs_attention: "需要处理", failed_no_switch: "失败，未切换", cancelled: "已取消" })
    readonly property var target: u.target || ({})
    readonly property bool activatable: !!u.updateId && ["staged", "waiting_confirmation", "quiescing"].indexOf(u.state) >= 0
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: updateCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: updateCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s3
            PText { objectName: "updateSummary"; text: "当前：" + (u.fromReleaseId || "未知") + "  候选：" + (u.toReleaseId || "无") + "  状态：" + (stateText[u.state || "none"] || u.state); variant: "subhead"; bold: true }
            PText { visible: !!u.error; text: u.error ? (u.error.code || "") : ""; tone: "danger" }
            RowLayout {
                spacing: Theme.s2
                AButton { label: "检查更新"; variant: "primary"; onConfirmed: shell.act("updates.check", {}, "检查更新") }
                AButton { label: "准备更新"; enabled: !!root.target.releaseId; writeAction: true
                    onConfirmed: shell.act("updates.prepare", {releaseId:root.target.releaseId, manifestHash:root.target.manifestHash}, "准备更新") }
                AButton { objectName: "updateActivate"; label: "重启并试启动"; variant: "danger"; writeAction: true; enabled: root.activatable
                    onConfirmed: shell.hardware("admin.update", {step:"activate", updateId:root.u.updateId}) }
                AButton { label: "取消"; enabled: !!root.u.toReleaseId
                    onConfirmed: shell.act("updates.cancel", {releaseId:root.u.toReleaseId || ""}, "取消更新") }
            }
        }
    }
    ActionsList { }
}
