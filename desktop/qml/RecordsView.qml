import QtQuick
import QtQuick.Controls.Basic
// formatVersion 1 records view: table, search, filters, create/edit form keeping hidden fields and default rules.
Column {
    id: r
    property var view: null
    readonly property var st: view ? view.recordState : ({})
    readonly property real s: (typeof shell !== "undefined" && shell) ? shell.uiScale : 1
    spacing: 8
    Flow { width: r.width; spacing: 8
        AField { visible: !!r.st.searchable; width: 220 * r.s; label: "搜索"; placeholderText: "搜索"; boundValue: r.st.q || ""; onTextEdited: r.view.setSearch(text) }
        Repeater { model: r.view ? r.view.filterFields : []
            delegate: ASelect { label: "筛选" + modelData.label; value: modelData.value
                options: [{ value: "", label: modelData.label + "：全部" }].concat(modelData.options)
                onChosen: function(v) { r.view.setFilter(modelData.key, v) } } }
        AButton { visible: !!r.st.writable; label: "新建"; variant: "primary"; enabled: !r.st.formOpen; onClicked: r.view.openCreate() }
    }
    PText { visible: !!r.st.error; width: r.width; text: r.st.error || ""; color: "#a01515" }
    Rectangle {
        visible: !!r.st.formOpen
        width: r.width; implicitHeight: fc.implicitHeight + 16; height: visible ? implicitHeight : 0; color: "#fafafa"; border.color: "#cccccc"; radius: 6
        Accessible.role: Accessible.Dialog; Accessible.name: r.st.formMode === "create" ? "新建记录" : "编辑记录"
        Column { id: fc; x: 8; y: 8; width: parent.width - 16; spacing: 6
            PText { text: r.st.formMode === "create" ? "新建记录" : "编辑记录"; font.bold: true }
            Row { visible: !!r.st.formStale; spacing: 6
                PText { text: "应用版本已切换，表单已停用。你的输入已保留。"; color: "#7a5a00" }
                AButton { label: "刷新表单"; onClicked: r.view.rebaseRecord() } }
            Repeater { model: r.view ? r.view.recordForm : []
                delegate: Column { width: fc.width; spacing: 2
                    PText { text: modelData.label; variant: "small" }
                    ACheck { visible: modelData.type === "boolean"; label: modelData.label; checked: modelData.value === true; enabled: !r.st.formStale && !r.st.formBusy; onToggled: r.view.setDraft(modelData.name, checked) }
                    ASelect { visible: modelData.type === "enum"; label: modelData.label; value: String(modelData.value)
                              options: modelData.options.map(function(o) { return { value: o, label: o } }); enabled: !r.st.formStale && !r.st.formBusy
                              onChosen: function(v) { r.view.setDraft(modelData.name, v) } }
                    AField { visible: modelData.type === "string" || modelData.type === "integer"; width: Math.min(fc.width, 420 * r.s); label: modelData.label
                             boundValue: String(modelData.value); enabled: !r.st.formStale && !r.st.formBusy
                             inputMethodHints: modelData.type === "integer" ? Qt.ImhFormattedNumbersOnly : Qt.ImhNone
                             onTextEdited: r.view.setDraft(modelData.name, text) }
                    PText { visible: modelData.error !== ""; text: modelData.error; color: "#a01515"; variant: "small" } } }
            PText { visible: !!r.st.formMessage; width: fc.width; text: r.st.formMessage || ""; color: "#a01515" }
            Row { spacing: 8
                AButton { label: r.st.formMessage && !r.st.formStale ? "重试" : "保存"; variant: "primary"; enabled: !r.st.formStale && !r.st.formBusy; onClicked: r.view.submitRecord() }
                AButton { label: "取消"; onClicked: r.view.cancelRecord() } } } }
    Row { spacing: 8
        Repeater { model: r.view ? r.view.records.headers : []; delegate: PText { width: 150 * r.s; text: modelData; font.bold: true } }
        PText { visible: !!r.st.writable; text: "操作"; font.bold: true } }
    Repeater { model: r.view ? r.view.records : null
        delegate: Row { spacing: 8
            readonly property int rowIndex: index
            Repeater { model: r.view.records.headers.length; delegate: PText { width: 150 * r.s; text: r.view.records.cellAt(parent.rowIndex, index); elide: Text.ElideRight; maximumLineCount: 2 } }
            AButton { visible: !!r.st.writable; label: "编辑"; enabled: !r.st.formOpen; onClicked: r.view.openEdit(parent.rowIndex) }
            AButton { visible: !!r.st.writable; label: "删除"; variant: "danger"; onClicked: r.view.askDelete(parent.rowIndex) } } }
    PText { visible: r.view && r.view.records.rows === 0; text: "没有记录"; variant: "muted" }
    Row { spacing: 8
        AButton { label: "上一页"; enabled: !!r.st.hasPrev; onClicked: r.view.pageBy(-1) }
        PText { text: r.st.pageText || "" }
        AButton { label: "下一页"; enabled: !!r.st.hasNext; onClicked: r.view.pageBy(1) } }
    Rectangle { visible: !!r.st.hasDelete; width: r.width; implicitHeight: dc.implicitHeight + 12; height: visible ? implicitHeight : 0; color: "#fff4d6"; radius: 4
        Accessible.role: Accessible.AlertMessage; Accessible.name: "确认删除"
        Column { id: dc; x: 6; y: 6; width: parent.width - 12; spacing: 4
            PText { width: parent.width; text: "删除“" + (r.st.deleteAsk || "") + "”？删除是永久的，切换应用版本不会恢复它（只能从备份恢复）。" }
            Row { spacing: 8
                AButton { label: "确认删除"; variant: "danger"; onClicked: r.view.confirmDelete(true) }
                AButton { label: "取消"; onClicked: r.view.confirmDelete(false) } } } }
}
