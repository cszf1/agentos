import QtQuick
import QtQuick.Layouts

PageFrame {
    id: root
    title: "首页"
    subtitle: "原生应用画布 · 连接与权限由可信 Shell 管理"
    property string targetApp: ""
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: intentCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: intentCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s2
            PText { text: "快速意图与生成"; variant: "caption"; tone: "secondary"; bold: true }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s3
                AField { id: intent; objectName: "intentInput"; label: "意图输入"; Layout.fillWidth: true
                    placeholder: shell.modelAvailable ? "想做什么？例如：做一个记账应用" : "模型暂不可用"
                    boundValue: shell.intentDraft; enterSubmits: true; enabled: shell.modelAvailable && !shell.readOnly
                    onTextEdited: shell.intentDraft = text
                    onSubmitted: function(v) { if (!shell.readOnly && shell.modelAvailable) shell.submitIntent(v, root.targetApp) }
                }
                ASelect { id: intentTarget; label: "目标应用"; value: root.targetApp
                    options: {
                        var options = [{value:"",label:"新应用"}]
                        for (var i = 0; i < shell.apps.count; ++i) {
                            var a = shell.apps.get(i)
                            options.push({value:a.appId, label:a.title || a.appId})
                        }
                        return options
                    }
                    onChosen: function(v) { root.targetApp = v }
                }
                AButton { objectName: "intentSubmit"; label: "提交"; variant: "primary"; writeAction: true
                    enabled: shell.modelAvailable && !shell.readOnly
                    onConfirmed: shell.submitIntent(intent.boundValue, root.targetApp) }
            }
        }
    }
    Connections { target: shell; function onScopeCleared(reason) { root.targetApp = "" } }
    RowLayout {
        Layout.fillWidth: true; spacing: Theme.s4
        Rectangle {
            Layout.fillWidth: true; implicitHeight: healthCol.implicitHeight + Theme.s4 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin
            ColumnLayout {
                id: healthCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s2
                PText { text: "系统状态"; variant: "subhead"; bold: true }
                PText { text: "工作区服务：" + (shell.hostAvailable ? "正常" : "不可用（只读）"); tone: shell.hostAvailable ? "success" : "danger" }
                PText { text: "模型：" + (shell.modelAvailable ? "可用" : "不可用") }
                PText { text: "Broker：" + (shell.brokerAvailable ? "可用" : "不可用") }
                PText { text: "当前工作区：" + shell.workspaceName; tone: "secondary" }
            }
        }
        Rectangle {
            Layout.fillWidth: true; implicitHeight: tasksCol.implicitHeight + Theme.s4 * 2
            radius: Theme.radiusCard; color: Theme.bgSurface; border.color: Theme.border; border.width: Theme.borderThin
            ColumnLayout {
                id: tasksCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s2
                PText { text: "最近任务"; variant: "subhead"; bold: true }
                Repeater { model: shell.runs
                    delegate: PText { visible: index < 4; Layout.fillWidth: true
                        text: (row.intent || row.runId) + " — " + (row.status || row.state || ""); variant: "caption"; elide: Text.ElideRight } }
                PText { visible: shell.runs.count === 0; text: "没有任务"; tone: "muted" }
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        PText { text: "应用画布（最多同时展开 4 张）"; variant: "subhead"; bold: true; Layout.fillWidth: true }
        AButton { label: "重新排列"; onConfirmed: { shell.canvas.arrange(); shell.saveLayout() } }
    }
    Flow {
        Layout.fillWidth: true; width: root.width - Theme.s6 * 2; spacing: Theme.s3
        objectName: "canvas"
        Repeater {
            model: shell.canvas
            delegate: Rectangle {
                id: card
                clip: true
                objectName: "card:" + appId
                width: expanded ? Math.min(root.width - Theme.s6 * 2, Theme.px(520) * cw) : Theme.px(260)
                implicitHeight: cardCol.implicitHeight + Theme.s3 * 2; height: implicitHeight
                radius: Theme.radiusCard; color: Theme.bgSurface
                border.color: pinned ? Theme.accent : Theme.borderStrong; border.width: Theme.borderThin
                Behavior on border.color { ColorAnimation { duration: 150; easing.type: Easing.OutCubic } }
                ColumnLayout {
                    id: cardCol; anchors.fill: parent; anchors.margins: Theme.s3; spacing: Theme.s2
                    RowLayout {
                        Layout.fillWidth: true
                        PText { text: title; variant: "subhead"; bold: true; Layout.fillWidth: true; elide: Text.ElideRight }
                        AButton { label: expanded ? "收起" : "展开"; compact: true; onConfirmed: shell.expandCard(appId, !expanded) }
                        AButton { label: "打开"; compact: true; variant: "primary"; onConfirmed: shell.openApp(appId) }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        AButton { label: pinned ? "取消固定" : "固定"; compact: true; onConfirmed: { shell.canvas.setPinned(appId,!pinned); shell.saveLayout() } }
                        AButton { label: "←"; compact: true; onConfirmed: { shell.canvas.move(appId,cx-1,cy); shell.saveLayout() } }
                        AButton { label: "→"; compact: true; onConfirmed: { shell.canvas.move(appId,cx+1,cy); shell.saveLayout() } }
                        AButton { label: "宽"; compact: true; onConfirmed: { shell.canvas.resize(appId,cw%2+1,ch); shell.saveLayout() } }
                    }
                    // Critical: render actual C++ AppViewModel, never fabricated JS slot arrays.
                    SlotCanvas { visible: expanded && view !== null; Layout.fillWidth: true; width: cardCol.width
                        view: expanded ? model.view : null; height: visible ? implicitHeight : 0 }
                }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: notifCol.implicitHeight + Theme.s4 * 2
        radius: Theme.radiusCard
        color: Theme.bgSurface
        border.color: Theme.border
        border.width: Theme.borderThin
        ColumnLayout {
            id: notifCol
            anchors.fill: parent
            anchors.margins: Theme.s4
            spacing: Theme.s2
            PText { text: "通知"; variant: "subhead"; bold: true }
            Repeater { model: shell.notifications
                delegate: PText { objectName: "notification:" + row.id; visible: index < 4; Layout.fillWidth: true
                    text: (row.title || "") + (row.count > 1 ? "（" + row.count + " 次）" : ""); color: row.severity === "critical" || row.severity === "error" ? "#a01515" : Theme.textSecondary } }
            PText { visible: shell.notifications.count === 0; text: "暂无系统通知"; tone: "muted"; variant: "caption" }
        }
    }
    ActionsList { }
}
