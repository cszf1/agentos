import QtQuick
PageFrame {
    title: "应用详情与版本"
    readonly property var app: shell.currentApp
    PText { visible: !app; text: "从首页打开一个应用"; variant: "muted" }
    Row { visible: !!app; spacing: 8
        AButton { label: "归档此应用"; onClicked: shell.act("app.archive", { appId: app.appId, appEpoch: app.appEpoch }, "归档应用") }
        AButton { label: "恢复此应用"; onClicked: shell.act("app.restore", { appId: app.appId }, "恢复应用") }
        AButton { label: "启动运行时"; onClicked: shell.act("app.runtime", { appId: app.appId, action: "start", appEpoch: app.appEpoch }, "启动应用") }
        AButton { label: "停止运行时"; onClicked: shell.act("app.runtime", { appId: app.appId, action: "stop", appEpoch: app.appEpoch }, "停止应用") }
        AButton { label: "重启运行时"; onClicked: shell.act("app.runtime", { appId: app.appId, action: "restart", appEpoch: app.appEpoch }, "重启应用") } }
    SlotCanvas { visible: !!app; width: parent.width; view: app }
    PText { text: "版本"; font.bold: true }
    Repeater { model: shell.revisions
        delegate: Row { spacing: 8
            PText { width: 360 * shell.uiScale; text: (row.label || row.revisionId) + (row.active ? "（当前）" : ""); elide: Text.ElideMiddle; maximumLineCount: 1 }
            PText { text: row.createdAt || ""; variant: "small" }
            AButton { label: "切换到此版本"; enabled: !row.active; onClicked: shell.act("app.deploy", { appId: app.appId, revisionId: row.revisionId, appEpoch: row.appEpoch || 0 }, "切换版本") } } }
    ActionsList { prefix: "app." }
}
