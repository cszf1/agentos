import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import AgentOS.Native
// One Slot Tree node. node.type picks a component from this FIXED table; unknown types become an error card.
// node.data holds plain values only; nothing from it is ever evaluated or interpreted as markup.
Item {
    id: root
    property var node: null
    property var view: null
    readonly property var d: node ? node.data : ({})
    readonly property real s: (typeof shell !== "undefined" && shell) ? shell.uiScale : 1
    readonly property int gapPx: d.gap === "sm" ? 6 : d.gap === "lg" ? 20 : 12
    visible: node !== null && node.shown
    implicitWidth: loader.item ? loader.item.implicitWidth : 0
    implicitHeight: visible && loader.item ? loader.item.implicitHeight : 0
    width: parent ? parent.width : implicitWidth
    height: implicitHeight
    Loader {
        id: loader
        width: root.width
        active: root.node !== null && root.node.shown
        sourceComponent: {
            if (!root.node) return null
            switch (root.node.type) {
            case "Stack": return root.d.direction === "horizontal" ? hstackC : vstackC
            case "Grid": return gridC
            case "Tabs": return tabsC
            case "Text": return textC
            case "Alert": return alertC
            case "Metric": return metricC
            case "Table": return tableC
            case "Kanban": return kanbanC
            case "Form": return formC
            case "TextInput": return textInputC
            case "TextArea": return textAreaC
            case "Select": return selectC
            case "Checkbox": return checkboxC
            case "Button": return buttonC
            case "SystemActionButton": return systemButtonC
            case "BarChart": return chartC
            case "LineChart": return chartC
            case "List": return listC
            case "ListItem": return vstackC
            default: return errorC
            }
        }
    }

    Component { id: vstackC
        Column { width: root.width; spacing: root.gapPx
            Repeater { model: root.node.kids; delegate: SlotChild { width: parent.width; n: modelData; v: root.view } } } }
    Component { id: hstackC
        Flow { width: root.width; spacing: root.gapPx
            Repeater { model: root.node.kids; delegate: SlotChild { n: modelData; v: root.view; width: Math.max(80, item ? item.implicitWidth : 80) } } } }
    Component { id: gridC
        GridLayout { width: root.width; columns: Math.max(1, Math.min(4, root.d.columns)); columnSpacing: root.gapPx; rowSpacing: root.gapPx
            Repeater { model: root.node.kids; delegate: SlotChild { Layout.fillWidth: true; Layout.preferredWidth: 1; n: modelData; v: root.view; height: item ? item.implicitHeight : 0; Layout.preferredHeight: height } } } }
    Component { id: tabsC
        Column { width: root.width; spacing: 6
            TabBar { id: bar; width: parent.width; currentIndex: root.d.active
                Repeater { model: root.d.labels; delegate: ATab { label: modelData; onClicked: root.view.setTab(root.node.path, index) } } }
            Repeater { model: root.node.kids; delegate: SlotChild { width: parent.width; n: modelData; v: root.view } } } }
    Component { id: textC
        PText { width: root.width; text: root.d.text; variant: root.d.variant } }
    Component { id: alertC
        Rectangle { width: root.width; implicitHeight: at.implicitHeight + 16; radius: 4
            color: root.d.status === "error" ? "#fde7e7" : root.d.status === "warning" ? "#fff4d6" : root.d.status === "success" ? "#e2f5e8" : "#e6effc"
            Accessible.role: Accessible.AlertMessage; Accessible.name: root.d.text
            PText { id: at; x: 8; y: 8; width: parent.width - 16; text: root.d.text } } }
    Component { id: metricC
        Column { width: root.width
            PText { text: root.d.label; variant: "muted" }
            PText { text: root.d.value + (root.d.unit !== null && root.d.unit !== undefined ? " " + root.d.unit : ""); font.pixelSize: 22 * root.s; font.bold: true } } }
    Component { id: tableC
        Column { width: root.width; spacing: 4
            readonly property var tm: root.node.table
            Row { spacing: 8
                Item { width: root.d.selectionId ? 28 : 0; height: 1 }
                Repeater { model: tm.headers; delegate: PText { width: 140 * root.s; text: modelData; font.bold: true } } }
            Repeater { model: tm
                delegate: Row { spacing: 8
                    ACheck { visible: !!root.d.selectionId; width: visible ? 28 : 0; label: "选择 " + tm.rowIdAt(index); checked: tm.selectedAt(index)
                             onToggled: root.view.toggle(root.d.selectionId, tm.rowIdAt(index), checked) }
                    Repeater { model: tm.headers.length; delegate: PText { width: 140 * root.s; text: tm.cellAt(parent.rowIndex, index); elide: Text.ElideRight; maximumLineCount: 2 } }
                    readonly property int rowIndex: index } }
            PText { visible: root.d.emptyText !== null && root.d.emptyText !== undefined; text: root.d.emptyText || ""; variant: "muted" }
            Row { spacing: 8; visible: root.d.pages > 1
                AButton { label: "上一页"; enabled: root.d.page > 0; onClicked: root.view.setPage(root.node.path, root.d.page - 1) }
                PText { text: (root.d.page + 1) + "/" + root.d.pages; variant: "muted" }
                AButton { label: "下一页"; enabled: root.d.page + 1 < root.d.pages; onClicked: root.view.setPage(root.node.path, root.d.page + 1) } } } }
    Component { id: kanbanC
        Flow { width: root.width; spacing: 10
            Repeater { model: root.d.columns
                delegate: Rectangle { width: Math.max(180, (root.width - 20) / Math.max(1, root.d.columns.length) - 10); implicitHeight: kc.implicitHeight + 12; height: implicitHeight; color: "#f2f4f7"; radius: 6
                    Accessible.role: Accessible.List; Accessible.name: modelData.label
                    Column { id: kc; x: 6; y: 6; width: parent.width - 12; spacing: 6
                        PText { text: modelData.label + "  " + modelData.count; font.bold: true }
                        Repeater { model: modelData.cards
                            delegate: Rectangle { width: kc.width; implicitHeight: cc.implicitHeight + 10; height: implicitHeight; radius: 4; color: modelData.selected ? "#dce7fb" : "#ffffff"; border.color: "#d0d0d0"
                                Column { id: cc; x: 5; y: 5; width: parent.width - 10
                                    ACheck { visible: !!root.d.selectionId; label: "选择 " + modelData.title; checked: modelData.selected; onToggled: root.view.toggle(root.d.selectionId, modelData.id, checked) }
                                    PText { width: parent.width; text: modelData.title; font.bold: true }
                                    Repeater { model: modelData.fields; delegate: PText { width: cc.width; text: modelData; variant: "small" } } } } } } } } } }
    Component { id: formC
        Rectangle { width: root.width; implicitHeight: fc.implicitHeight + 16; color: "#fafafa"; border.color: "#dddddd"; radius: 6
            Accessible.role: Accessible.Form; Accessible.name: root.d.title || root.d.formId
            Column { id: fc; x: 8; y: 8; width: parent.width - 16; spacing: 8
                PText { visible: !!root.d.title; text: root.d.title || ""; font.bold: true }
                Repeater { model: root.node.kids; delegate: SlotChild { width: fc.width; n: modelData; v: root.view } } } } }
    Component { id: textInputC
        Column { width: root.width; spacing: 2
            PText { text: root.d.label; variant: "small" }
            AField { id: tf; width: Math.min(parent.width, 420 * root.s); label: root.d.label; maximumLength: root.d.maxLength
                     Component.onCompleted: boundValue = root.node.data.value
                     Connections { target: root.node; function onChanged() { tf.boundValue = root.node.data.value } }
                     placeholderText: root.d.placeholder; inputMethodHints: root.d.mode === "integer" ? Qt.ImhFormattedNumbersOnly : Qt.ImhNone
                     onTextEdited: root.view.typeText(root.d.formId, root.d.name, text) } } }
    Component { id: textAreaC
        Column { width: root.width; spacing: 2
            PText { text: root.d.label; variant: "small" }
            AArea { id: ta; width: Math.min(parent.width, 480 * root.s); label: root.d.label
                    Component.onCompleted: boundValue = root.node.data.value
                    Connections { target: root.node; function onChanged() { ta.boundValue = root.node.data.value } }
                    onTextChanged: if (activeFocus && text !== root.node.data.value) root.view.typeText(root.d.formId, root.d.name, text) } } }
    Component { id: selectC
        Column { width: root.width; spacing: 2
            PText { text: root.d.label; variant: "small" }
            ASelect { label: root.d.label; value: root.d.value
                      options: (root.d.allowDefault ? [{ value: "", label: "（默认）" }] : []).concat(root.d.options)
                      onChosen: function(v) { root.view.choose(root.d.formId, root.d.name, v) } } } }
    Component { id: checkboxC
        ACheck { label: root.d.label; checked: root.d.checked; onToggled: root.view.check(root.d.formId, root.d.name, checked) } }
    Component { id: buttonC
        AButton { label: root.d.label; variant: root.d.variant; enabled: !root.d.disabled; onClicked: root.view.click(root.node.path) } }
    Component { id: systemButtonC
        Column { spacing: 2
            AButton { label: "⚙ " + root.d.label; variant: root.d.variant; enabled: !root.d.disabled; onClicked: root.view.click(root.node.path) }
            PText { text: "系统动作：先生成计划，由 AgentOS 可信确认层确认后才执行"; variant: "small" } } }
    Component { id: chartC
        Column { width: root.width; spacing: 4
            Accessible.role: Accessible.Chart; Accessible.name: (root.d.title || root.node.type)
            PText { visible: !!root.d.title; text: root.d.title || "" ; font.bold: true }
            ChartItem { width: Math.min(parent.width, 560 * root.s); height: 180 * root.s; kind: root.node.type; xs: root.d.xs; series: root.d.series; maxValue: root.d.max
                        Accessible.role: Accessible.Chart; Accessible.name: (root.d.title || root.node.type) + "（数据见下方）" }
            Flow { width: parent.width; spacing: 10
                Repeater { model: root.d.series
                    delegate: Row { spacing: 4
                        Rectangle { width: 10; height: 10; color: ["#3b6fd8", "#d8833b", "#3ba86b", "#a83b8f", "#8f8f3b", "#3b9fa8", "#a83b3b", "#6b6b6b"][index % 8]; anchors.verticalCenter: parent.verticalCenter }
                        PText { text: modelData.label } } } }
            AButton { id: dataBtn; checkable: true; label: checked ? "隐藏数据" : "查看数据" }
            Repeater { model: dataBtn.checked ? root.d.series : []
                delegate: PText { width: root.width; variant: "small"
                    text: modelData.label + "：" + modelData.values.map(function(v, i) { return root.d.xs[i] + "=" + v }).join("，") } }
            PText { visible: root.d.truncatedRows > 0; variant: "small"; text: "只显示前 500 个点（另有 " + root.d.truncatedRows + " 个）" } } }
    Component { id: listC
        Column { width: root.width; spacing: 4
            PText { visible: root.d.emptyText !== null && root.d.emptyText !== undefined; text: root.d.emptyText || ""; variant: "muted" }
            ListView {
                id: lv
                objectName: "slotList"
                width: parent.width
                height: count > 0 ? Math.min(Math.max(contentHeight, 60 * root.s), 520 * root.s) : 0
                clip: true
                model: root.node.list
                spacing: root.gapPx
                orientation: root.d.direction === "horizontal" ? ListView.Horizontal : ListView.Vertical
                cacheBuffer: 200
                reuseItems: false
                Accessible.role: Accessible.List
                Accessible.name: "列表"
                ScrollBar.vertical: ScrollBar { }
                delegate: Item {
                    id: del
                    required property var itemNode
                    required property int index
                    property bool granted: false
                    readonly property int cost: Math.max(1, root.d.templateNodes)
                    width: lv.orientation === ListView.Vertical ? lv.width : 260 * root.s
                    // placeholder sized like the real template so scrolling is stable before budget/instantiation
                    height: granted && body.item ? body.item.implicitHeight : cost * 27 * root.s
                    Accessible.role: Accessible.ListItem
                    Accessible.name: "第 " + (index + 1) + " 项"
                    Component.onCompleted: granted = InstanceBudget.acquire(cost)
                    Component.onDestruction: if (granted) InstanceBudget.release(cost)
                    Connections { target: InstanceBudget; function onFreed() { if (!del.granted) del.granted = InstanceBudget.acquire(del.cost) } }
                    PText { visible: !del.granted; text: "（渲染预算已满，滚动后显示）"; variant: "small" }
                    Loader { id: body; width: del.width; active: del.granted
                        sourceComponent: Column { width: del.width; spacing: 4
                            Repeater { model: del.itemNode ? del.itemNode.kids : []; delegate: SlotChild { width: del.width; n: modelData; v: root.view } } } }
                }
            }
            PText { visible: !!root.d.more; text: root.d.more || ""; variant: "small" } } }
    Component { id: errorC
        Rectangle { width: root.width; implicitHeight: ec.implicitHeight + 16; color: "#fde7e7"; radius: 4
            Column { id: ec; x: 8; y: 8; width: parent.width - 16
                PText { width: parent.width; text: root.d.text ? root.d.text : ("未知组件 " + (root.node ? root.node.type : "")) } } } }
}
