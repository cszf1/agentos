import QtQuick
import QtQuick.Layouts

// An app, full size: its own view first; management and versions below it.
PageFrame {
    id: root
    readonly property var app: shell.currentApp
    title: root.app ? "" : "应用"
    subtitle: root.app ? "" : "从桌面打开一个应用。"

    RowLayout {
        visible: !root.app
        spacing: Theme.s2
        LinkButton { text: "回到桌面"; onClicked: shell.currentPage = "home" }
    }
    Rectangle {
        visible: !!root.app; Layout.fillWidth: true
        implicitHeight: content.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
        ColumnLayout {
            id: content; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s3
            // Keep the live C++ app view: the new mock SlotCanvas would bypass renderer validation and app forms.
            SlotCanvas { Layout.fillWidth: true; visible: !!root.app; view: root.app; width: content.width }
        }
    }

    PText { visible: !!root.app; text: "管理"; variant: "caption"; tone: "muted"; Layout.topMargin: Theme.s2 }
    Flow {
        visible: !!root.app
        Layout.fillWidth: true
        spacing: Theme.s2
        AButton { compact: true; label: "启动运行时"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"start", appEpoch:root.app.appEpoch}, "启动应用") }
        AButton { compact: true; label: "重启运行时"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"restart", appEpoch:root.app.appEpoch}, "重启应用") }
        AButton { compact: true; label: "停止运行时"; variant: "danger"; onConfirmed: if (root.app) shell.act("app.runtime", {appId:root.app.appId, action:"stop", appEpoch:root.app.appEpoch}, "停止应用") }
        AButton { compact: true; label: "归档此应用"; onConfirmed: if (root.app) shell.act("app.archive", {appId: root.app.appId, appEpoch:root.app.appEpoch}, "归档应用") }
        AButton { compact: true; label: "恢复此应用"; onConfirmed: if (root.app) shell.act("app.restore", {appId:root.app.appId}, "恢复应用") }
    }

    PText { text: "版本"; variant: "caption"; tone: "muted"; Layout.topMargin: Theme.s2 }
    Rectangle {
        Layout.fillWidth: true
        visible: shell.revisions.count > 0
        implicitHeight: versions.implicitHeight + Theme.px(8)
        radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin
        ColumnLayout {
            id: versions
            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
            anchors.margins: Theme.px(4)
            spacing: 0
            Repeater {
                model: shell.revisions
                delegate: Item {
                    Layout.fillWidth: true
                    implicitHeight: versionRow.implicitHeight + Theme.s2 * 2
                    Rectangle { visible: index > 0; anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right; anchors.leftMargin: Theme.s3; anchors.rightMargin: Theme.s3; height: Theme.borderThin; color: Theme.border }
                    RowLayout {
                        id: versionRow; anchors.fill: parent; anchors.leftMargin: Theme.s3; anchors.rightMargin: Theme.s2; spacing: Theme.s2
                        Rectangle { width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3); color: row.isActive ? Theme.success : "transparent" }
                        PText { text: (row.title || row.revisionId) + (row.isActive ? "（当前）" : ""); Layout.fillWidth: true; bold: !!row.isActive; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                        PText { text: row.createdAt || ""; tone: "muted"; variant: "caption"; mono: true }
                        AButton { objectName: "switchToVersion"; compact: true; label: "切换到此版本"; enabled: !row.isActive && !!root.app
                            onConfirmed: if (root.app) shell.act("app.deploy", {appId:root.app.appId, revisionId:row.revisionId, appEpoch:root.app.appEpoch}, "切换版本") }
                    }
                }
            }
        }
    }
    PText { visible: shell.revisions.count === 0; text: "暂无版本记录"; tone: "muted" }
    ActionsList { prefix: "app." }
}
