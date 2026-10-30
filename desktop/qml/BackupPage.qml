import QtQuick
PageFrame {
    title: "备份与恢复"
    Row { spacing: 8
        AButton { label: "创建工作区备份"; onClicked: shell.act("backups.create", { scope: "workspace" }, "创建备份") }
        ASelect { id: mode; label: "恢复方式"; value: "same-machine"; options: [{ value: "same-machine", label: "同机恢复" }, { value: "clone", label: "克隆到新工作区" }, { value: "workspace", label: "仅工作区数据" }] } }
    Repeater { model: shell.backups
        delegate: Row { spacing: 8
            PText { width: 260 * shell.uiScale; text: (row.backupId || "") + " " + (row.createdAt || ""); elide: Text.ElideRight; maximumLineCount: 1 }
            PText { text: row.state || "" }
            AButton { label: "检查"; onClicked: shell.act("backups.inspect", { backupId: row.backupId }, "检查备份") }
            AButton { label: "导出到 U 盘"; onClicked: shell.act("backups.export", { backupId: row.backupId, targetId: "removable" }, "导出备份") }
            AButton { label: "生成恢复计划"; variant: "danger"; onClicked: shell.act("restores.plan", { backupId: row.backupId, mode: mode.currentValue }, "恢复计划") } } }
    PText { visible: shell.backups.count === 0; text: "没有备份"; variant: "muted" }
    ActionsList { prefix: "" }
}
