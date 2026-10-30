import QtQuick
import QtQuick.Controls.Basic
PageFrame {
    id: page
    title: "首页"
    // intent input
    Row { spacing: 8; width: parent.width
        AField { id: intent; objectName: "intentInput"; width: Math.min(560 * shell.uiScale, parent.width - 260); label: "意图输入"; placeholderText: shell.modelAvailable ? "想做什么？例如：做一个记账应用" : "模型不可用：暂不能生成或修改应用"
                 boundValue: shell.intentDraft; enabled: shell.modelAvailable && !shell.readOnly; onTextEdited: shell.intentDraft = text
                 onAccepted: shell.submitIntent(text, target.value) }
        ASelect { id: target; label: "目标应用"; value: ""; options: { var o = [{ value: "", label: "新应用" }]; for (var i = 0; i < shell.apps.count; ++i) { var a = shell.apps.get(i); o.push({ value: a.appId, label: a.title || a.appId }) } return o } }
        AButton { objectName: "intentSubmit"; label: "提交"; variant: "primary"; enabled: shell.modelAvailable && !shell.readOnly; onClicked: shell.submitIntent(intent.text, target.value) }
    }
    // system + task status
    Row { spacing: 24
        Column { spacing: 2
            PText { text: "系统状态"; font.bold: true }
            PText { text: "版本：" + (shell.machineStatus.release ? (shell.machineStatus.release.releaseId || shell.machineStatus.release) : "未知") }
            PText { text: "工作区服务：" + (shell.hostAvailable ? "正常" : "不可用（只读）") }
            PText { text: "模型：" + (shell.modelAvailable ? "可用" : "不可用") }
            PText { text: "系统执行服务：" + (shell.brokerAvailable ? "可用" : "不可用") } }
        Column { spacing: 2
            PText { text: "任务状态"; font.bold: true }
            Repeater { model: shell.runs; delegate: PText { visible: index < 5; height: visible ? implicitHeight : 0; text: (row.intent || row.runId) + " — " + (row.status || row.state || "") } }
            PText { visible: shell.runs.count === 0; text: "没有任务"; variant: "muted" } }
        Column { spacing: 2; width: 260 * shell.uiScale
            PText { text: "通知"; font.bold: true }
            Repeater { model: shell.notifications; delegate: PText { width: 260 * shell.uiScale; visible: index < 4; height: visible ? implicitHeight : 0; text: row.title || ""; elide: Text.ElideRight; maximumLineCount: 1 } } }
    }
    // app canvas
    Row { spacing: 8
        PText { text: "应用画布（最多同时展开 4 张卡）"; font.bold: true }
        AButton { label: "重新排列"; onClicked: { shell.canvas.arrange(); shell.saveLayout() } }
    }
    Flow {
        objectName: "canvas"
        width: parent.width
        spacing: 10
        Repeater {
            model: shell.canvas
            delegate: Rectangle {
                id: card
                objectName: "card:" + appId
                width: expanded ? Math.min(page.width - 40, 520 * cw * shell.uiScale) : 240 * shell.uiScale
                implicitHeight: cc.implicitHeight + 12
                height: implicitHeight
                radius: 6
                color: "#f7f8fa"
                border.color: pinned ? "#1a5fd0" : "#d0d0d0"
                Accessible.role: Accessible.Grouping
                Accessible.name: "应用卡片：" + title
                Column { id: cc; x: 6; y: 6; width: card.width - 12; spacing: 6
                    Row { spacing: 4
                        PText { text: title; font.bold: true; width: 120 * shell.uiScale; elide: Text.ElideRight; maximumLineCount: 1 }
                        AButton { label: expanded ? "收起" : "展开"; onClicked: shell.expandCard(appId, !expanded) }
                        AButton { label: pinned ? "取消固定" : "固定"; onClicked: { shell.canvas.setPinned(appId, !pinned); shell.saveLayout() } }
                        AButton { label: "打开"; onClicked: shell.openApp(appId) }
                        AButton { label: "←"; onClicked: { shell.canvas.move(appId, cx - 1, cy); shell.saveLayout() } }
                        AButton { label: "→"; onClicked: { shell.canvas.move(appId, cx + 1, cy); shell.saveLayout() } }
                        AButton { label: "宽"; onClicked: { shell.canvas.resize(appId, cw % 2 + 1, ch); shell.saveLayout() } } }
                    PText { visible: !expanded; text: "位置 " + cx + "," + cy; variant: "small" }
                    SlotCanvas { visible: expanded && view !== null; width: cc.width; height: visible ? implicitHeight : 0; view: expanded ? model.view : null }
                }
            }
        }
    }
    ActionsList { }
}
