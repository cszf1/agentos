import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "应用与版本"
    subtitle: "管理应用内容、运行状态与版本"
    readonly property var app: shell.currentApp
    PText { visible: !root.app; text: "从首页选择应用后查看"; tone: "muted" }
    Rectangle {
        visible: !!root.app; Layout.fillWidth: true
        implicitHeight: content.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border
        ColumnLayout {
            id: content; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s3
            PText { text: root.app ? root.app.title : ""; variant: "subhead"; bold: true }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s2
                AButton { label: "归档此应用"; onConfirmed: if (root.app) shell.act("app.archive", {appId: root.app.appId, appEpoch:root.app.appEpoch}, "归档应用") }
                AButton { label: "恢复此应用"; onConfirmed: if (root.app) shell.act("app.restore", {appId:root.app.appId}, "恢复应用") }
                AButton { label: "启动运行时"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"start", appEpoch:root.app.appEpoch}, "启动应用") }
                AButton { label: "停止运行时"; variant: "danger"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"stop", appEpoch:root.app.appEpoch}, "停止应用") }
                AButton { label: "重启运行时"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"restart", appEpoch:root.app.appEpoch}, "重启应用") }
            }
            // Keep the live C++ app view: the new mock SlotCanvas would bypass renderer validation and app forms.
            SlotCanvas { Layout.fillWidth: true; visible: !!root.app; view: root.app; width: content.width }
        }
    }
    PText { text: "版本"; variant: "subhead"; bold: true }
    Repeater {
        model: shell.revisions
        delegate: Rectangle {
            Layout.fillWidth: true; implicitHeight: versionRow.implicitHeight + Theme.s2 * 2
            radius: Theme.radiusControl; color: Theme.bgSurface; border.color: Theme.border
            RowLayout {
                id: versionRow; anchors.fill: parent; anchors.margins: Theme.s2
                PText { text: (row.title || row.revisionId) + (row.isActive ? "（当前）" : ""); Layout.fillWidth: true }
                PText { text: row.createdAt || ""; tone: "muted"; variant: "caption" }
                AButton { label: "切换到此版本"; enabled: !row.isActive && !!root.app
                    onConfirmed: if (root.app) shell.act("app.deploy", {appId:root.app.appId, revisionId:row.revisionId, appEpoch:root.app.appEpoch}, "切换版本") }
            }
        }
    }
    ActionsList { prefix: "app." }
}
