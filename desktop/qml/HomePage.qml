import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The desktop: say what you want; your apps below, as tiles or live widgets.
Item {
    id: root
    property var shellRoot: null
    property string targetApp: ""
    property string menuFor: ""
    Connections { target: shell; function onScopeCleared(reason) { root.targetApp = ""; root.menuFor = "" } }

    property date now: new Date()
    Timer { interval: 60000; running: true; repeat: true; onTriggered: root.now = new Date() }
    readonly property string greeting: {
        var h = now.getHours()
        if (h < 5) return "夜深了"
        if (h < 11) return "早上好"
        if (h < 13) return "中午好"
        if (h < 18) return "下午好"
        return "晚上好"
    }
    readonly property var activeRun: {
        for (var i = 0; i < shell.runs.count; ++i) {
            var r = shell.runs.get(i)
            if (["queued", "running", "accepted", "planning", "building"].indexOf(r.status || r.state) >= 0) return r
        }
        return null
    }

    ScrollView {
        id: scroll
        objectName: "desktopScroll"
        anchors.fill: parent
        clip: true
        contentWidth: availableWidth
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

        Item {
            width: scroll.availableWidth
            implicitHeight: col.implicitHeight + Theme.s6
            height: implicitHeight

            ColumnLayout {
                id: col
                width: Math.min(parent.width - Theme.s5 * 2, Theme.contentMax)
                anchors.horizontalCenter: parent.horizontalCenter
                y: Math.max(Theme.s5, Math.min(Theme.px(96), (scroll.height - Theme.px(420)) / 3))
                spacing: Theme.s3

                // ---- greeting ----
                PText {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    text: root.greeting + (shell.userName ? "，" + shell.userName : "")
                    font.pixelSize: Theme.textHero
                    font.weight: Font.Light
                    wrapMode: Text.NoWrap
                    elide: Text.ElideRight
                }
                PText {
                    Layout.fillWidth: true
                    Layout.bottomMargin: Theme.s3
                    horizontalAlignment: Text.AlignHCenter
                    text: shell.modelAvailable ? "想要什么，直接说。应用会随之生成。" : "连接模型后，就可以用一句话生成和修改应用。"
                    tone: "secondary"
                }

                // ---- composer ----
                Rectangle {
                    id: composer
                    objectName: "composer"
                    Layout.fillWidth: true
                    Layout.maximumWidth: Theme.px(720)
                    Layout.alignment: Qt.AlignHCenter
                    implicitHeight: Theme.px(60)
                    radius: Theme.px(20)
                    color: Theme.bgSurface
                    border.width: intent.activeFocus ? Theme.focusWidth : Theme.borderThin
                    border.color: intent.activeFocus ? Theme.borderFocus : Theme.border
                    Behavior on border.color { ColorAnimation { duration: Theme.animFast } }
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: Theme.px(8)
                        anchors.rightMargin: Theme.px(10)
                        spacing: Theme.px(6)
                        AField {
                            id: intent
                            objectName: "intentInput"
                            flat: true
                            Layout.fillWidth: true
                            label: "意图输入"
                            placeholder: shell.modelAvailable ? (root.targetApp === "" ? "做一个记账应用…" : "想怎么改这个应用？") : "模型未连接"
                            boundValue: shell.intentDraft
                            enterSubmits: true
                            enabled: shell.modelAvailable && !shell.readOnly
                            font.pixelSize: Theme.textSubhead
                            onTextEdited: shell.intentDraft = text
                            onSubmitted: function(v) { if (!shell.readOnly && shell.modelAvailable) shell.submitIntent(v, root.targetApp) }
                        }
                        ASelect {
                            id: intentTarget
                            objectName: "intentTarget"
                            flat: true
                            compact: true
                            label: "目标应用"
                            Layout.preferredWidth: Theme.px(140)
                            value: root.targetApp
                            options: {
                                var options = [{value: "", label: "新应用"}]
                                for (var i = 0; i < shell.apps.count; ++i) {
                                    var a = shell.apps.get(i)
                                    options.push({value: a.appId, label: a.title || a.appId})
                                }
                                return options
                            }
                            onChosen: function(v) { root.targetApp = v }
                        }
                        AButton {
                            objectName: "intentSubmit"
                            label: "生成"
                            iconName: "arrowUp"
                            variant: "primary"
                            writeAction: true
                            enabled: shell.modelAvailable && !shell.readOnly && (intent.text.trim() !== "" || shell.intentDraft.trim() !== "")
                            disabledReason: shell.modelAvailable ? "" : "模型未连接"
                            onConfirmed: shell.submitIntent(intent.boundValue, root.targetApp)
                        }
                    }
                }

                // model missing: one line and the way to fix it
                RowLayout {
                    visible: !shell.modelAvailable
                    Layout.alignment: Qt.AlignHCenter
                    spacing: Theme.s2
                    Rectangle { width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3); color: Theme.warning }
                    PText { text: "尚未连接模型"; tone: "secondary"; wrapMode: Text.NoWrap }
                    LinkButton { objectName: "configureModel"; text: "连接模型"; onClicked: shell.currentPage = "model" }
                }
                // what is being made right now
                RowLayout {
                    visible: !!root.activeRun
                    Layout.alignment: Qt.AlignHCenter
                    spacing: Theme.s2
                    Rectangle {
                        width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3); color: Theme.accent
                        SequentialAnimation on opacity { running: !!root.activeRun; loops: Animation.Infinite
                            NumberAnimation { to: 0.25; duration: 700 } NumberAnimation { to: 1; duration: 700 } }
                    }
                    PText {
                        text: root.activeRun ? ("正在处理：" + (root.activeRun.intent || root.activeRun.runId)) : ""
                        tone: "secondary"; wrapMode: Text.NoWrap; elide: Text.ElideRight
                        Layout.maximumWidth: Theme.px(560)
                    }
                    LinkButton { text: "查看"; onClicked: shell.currentPage = "tasks" }
                }

                // ---- apps ----
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.s5
                    PText { text: "应用"; variant: "caption"; tone: "muted"; Layout.fillWidth: true }
                    LinkButton { objectName: "arrangeCanvas"; text: "整理"; visible: shell.canvas.count > 1; onClicked: { shell.canvas.arrange(); shell.saveLayout() } }
                }
                PText {
                    visible: shell.canvas.count === 0
                    Layout.fillWidth: true
                    text: "还没有应用。在上面说一句，比如“做一个待办应用”。"
                    tone: "muted"
                }
                Flow {
                    id: canvas
                    objectName: "canvas"
                    Layout.fillWidth: true
                    spacing: Theme.s3
                    Repeater {
                        model: shell.canvas
                        delegate: Rectangle {
                            id: card
                            objectName: "card:" + appId
                            readonly property bool widget: expanded
                            clip: true
                            width: widget ? Math.min(canvas.width, Theme.px(460) * cw) : Theme.px(132)
                            implicitHeight: widget ? (cardCol.implicitHeight + Theme.s3 * 2) : Theme.px(132)
                            height: implicitHeight
                            radius: Theme.radiusCard
                            color: tileArea.hovered && !widget ? Theme.bgHover : Theme.bgSurface
                            border.width: tileArea.activeFocus ? Theme.focusWidth : Theme.borderThin
                            border.color: tileArea.activeFocus ? Theme.borderFocus : Theme.border
                            Behavior on color { ColorAnimation { duration: Theme.animFast } }

                            // tile: the whole card opens the app
                            Button {
                                id: tileArea
                                property string label: "打开"
                                anchors.fill: parent
                                visible: !card.widget
                                enabled: !card.widget
                                hoverEnabled: true
                                focusPolicy: Qt.StrongFocus
                                Accessible.name: "打开 " + title
                                background: Item { }
                                contentItem: Item { }
                                onClicked: shell.openApp(appId)
                            }
                            ColumnLayout {
                                visible: !card.widget
                                anchors.centerIn: parent
                                width: parent.width - Theme.s3
                                spacing: Theme.s2
                                Rectangle {
                                    Layout.alignment: Qt.AlignHCenter
                                    width: Theme.px(48); height: Theme.px(48); radius: Theme.px(14)
                                    color: Theme.bgMuted
                                    PText { anchors.centerIn: parent; text: (title || "·").charAt(0); variant: "title"; font.weight: Font.Medium }
                                }
                                PText {
                                    Layout.fillWidth: true
                                    horizontalAlignment: Text.AlignHCenter
                                    text: title; maximumLineCount: 2; elide: Text.ElideRight
                                    variant: "caption"
                                }
                            }
                            Rectangle {
                                visible: pinned && !card.widget
                                anchors.top: parent.top; anchors.left: parent.left
                                anchors.margins: Theme.px(10)
                                width: Theme.px(6); height: Theme.px(6); radius: Theme.px(3); color: Theme.accent
                            }
                            IconButton {
                                objectName: "cardMenu:" + appId
                                tone: tileArea.hovered || hovered || root.menuFor === appId ? "secondary" : "muted"
                                anchors.top: parent.top; anchors.right: parent.right
                                anchors.margins: Theme.px(6)
                                iconName: "more"
                                Accessible.name: "更多"
                                z: 2
                                onClicked: root.menuFor = (root.menuFor === appId ? "" : appId)
                            }

                            // widget: the live app view inside the card
                            ColumnLayout {
                                id: cardCol
                                visible: card.widget
                                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                                anchors.margins: Theme.s3
                                spacing: Theme.s2
                                RowLayout {
                                    Layout.fillWidth: true
                                    Layout.rightMargin: Theme.px(28)
                                    PText { text: title; variant: "subhead"; bold: true; Layout.fillWidth: true; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                                    LinkButton { text: "打开"; onClicked: shell.openApp(appId) }
                                }
                                // Critical: render actual C++ AppViewModel, never fabricated JS slot arrays.
                                SlotCanvas { visible: card.widget && view !== null; Layout.fillWidth: true; width: cardCol.width
                                    view: card.widget ? model.view : null; height: visible ? implicitHeight : 0 }
                            }

                            // the card's menu
                            Rectangle {
                                visible: root.menuFor === appId
                                z: 3
                                anchors.top: parent.top; anchors.right: parent.right
                                anchors.topMargin: Theme.px(36); anchors.rightMargin: Theme.px(6)
                                width: Theme.px(150)
                                height: menuCol.implicitHeight + Theme.px(8)
                                radius: Theme.radiusControl
                                color: Theme.bgElevated
                                border.width: Theme.borderThin; border.color: Theme.borderStrong
                                ColumnLayout {
                                    id: menuCol
                                    anchors.fill: parent; anchors.margins: Theme.px(4)
                                    spacing: 0
                                    MenuRow { label: expanded ? "收起小组件" : "作为小组件"; onClicked: { root.menuFor = ""; shell.expandCard(appId, !expanded) } }
                                    MenuRow { label: pinned ? "取消固定" : "固定"; onClicked: { root.menuFor = ""; shell.canvas.setPinned(appId, !pinned); shell.saveLayout() } }
                                    MenuRow { label: "前移"; onClicked: { shell.canvas.move(appId, cx - 1, cy); shell.saveLayout() } }
                                    MenuRow { label: "后移"; onClicked: { shell.canvas.move(appId, cx + 1, cy); shell.saveLayout() } }
                                    MenuRow { visible: expanded; label: cw > 1 ? "窄一些" : "宽一些"; onClicked: { shell.canvas.resize(appId, cw % 2 + 1, ch); shell.saveLayout() } }
                                }
                            }
                        }
                    }
                }

                // ---- notifications (only when there are some) ----
                ColumnLayout {
                    visible: shell.notifications.count > 0
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.s4
                    spacing: Theme.s1
                    PText { text: "通知"; variant: "caption"; tone: "muted" }
                    Repeater { model: shell.notifications
                        delegate: PText { objectName: "notification:" + row.id; visible: index < 4; Layout.fillWidth: true
                            text: (row.title || "") + (row.count > 1 ? "（" + row.count + " 次）" : "")
                            color: row.severity === "critical" || row.severity === "error" ? Theme.danger : Theme.textSecondary } }
                }
                ActionsList { Layout.fillWidth: true }
            }
        }
    }
}
