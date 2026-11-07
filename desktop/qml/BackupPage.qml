import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "备份与恢复"
    subtitle: "快照备份、导出到 U 盘与恢复"
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: backupToolbar.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        RowLayout {
            id: backupToolbar
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s3
            AButton { label: "创建工作区备份"; variant: "primary"; writeAction: true
                onConfirmed: shell.act("backups.create", {scope:"workspace"}, "创建备份") }
            ASelect { id: mode; label: "恢复方式"; value: "same-machine"; options: [
                {value:"same-machine",label:"同机恢复"},{value:"clone",label:"克隆工作区"},{value:"workspace",label:"仅工作区数据"}] }
            Item { Layout.fillWidth: true }
        }
    }
    Repeater {
        model: shell.backups
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: r.implicitHeight + Theme.s3 * 2
            color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin; radius: Theme.radiusCard
            RowLayout {
                id: r; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s3
                PText { Layout.fillWidth: true; text: (row.backupId || "") + " " + (row.createdAt || ""); bold: true }
                PText { text: row.state || ""; tone: "secondary" }
                AButton { label: "检查"; onConfirmed: shell.act("backups.inspect", {backupId:row.backupId}, "检查备份") }
                AButton { label: "导出到 U 盘"; onConfirmed: shell.act("backups.export", {backupId:row.backupId, targetId:"removable"}, "导出备份") }
                AButton { label: "生成恢复计划"; variant: "danger"; writeAction: true
                    onConfirmed: shell.act("restores.plan", {backupId:row.backupId, mode:mode.currentValue}, "恢复计划") }
            }
        }
    }
    Rectangle {
        visible: shell.backups.count === 0
        Layout.fillWidth: true
        implicitHeight: emptyBkCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: emptyBkCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            PText { text: "没有备份"; tone: "muted" }
        }
    }
    ActionsList { }
}
