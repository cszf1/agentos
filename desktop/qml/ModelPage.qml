import QtQuick
import QtQuick.Layouts

// The workspace's model: what runs now, and connecting another one.
// The key goes in the plan's secret field only (machine action workspaces.modelCredential.set): never into params,
// never kept by the Shell. machined writes it to the workspace's model.env (0600, outside data/) and restarts its Host.
PageFrame {
    id: root
    objectName: "modelPage"
    title: "模型"
    subtitle: "这个工作区用来生成和修改应用的模型。"
    readonly property var info: shell.modelInfo || ({})
    readonly property bool connected: shell.modelAvailable
    readonly property bool owner: shell.role === "owner"
    readonly property string provider: "openai-compatible"

    property bool fieldsReady: false
    property bool prefilling: false
    property bool urlEdited: false
    property bool idEdited: false
    function prefill() {
        if (!fieldsReady || info.provider !== provider) return
        prefilling = true
        if (!urlEdited) baseUrl.boundValue = info.baseUrl || ""
        if (!idEdited) modelId.boundValue = info.modelId || ""
        prefilling = false
    }
    onInfoChanged: prefill()
    Component.onCompleted: { fieldsReady = true; prefill() }

    // the same checks machined applies (backends.rs model_credential_params / model_credential_text)
    function okChars(v, max, extra) {
        if (v.length === 0 || v.length > max) return false
        for (var i = 0; i < v.length; ++i) {
            var c = v.charAt(i)
            if (!(/[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0)) return false
        }
        return true
    }
    readonly property string urlText: baseUrl.boundValue.trim()
    readonly property string idText: modelId.boundValue.trim()
    readonly property string keyText: apiKey.boundValue
    readonly property string problem: {
        if (urlText === "" && idText === "" && keyText === "") return ""
        var endpoint = /^https?:\/\/([^/]+)/.exec(urlText)
        if (!endpoint || endpoint[1].indexOf("@") >= 0 || !okChars(urlText, 300, "-_.:/@%=&~+")) return "请填写不含登录凭据或查询参数的 HTTP 或 HTTPS 接口地址"
        if (!okChars(idText, 120, "-_.:/@")) return "模型 ID 只能包含字母、数字和 - _ . : / @"
        if (keyText.length === 0) return "请填写 API 密钥"
        if (keyText.length > 512 || !/^[\x21-\x7e]+$/.test(keyText)) return "API 密钥只能是可打印字符，不含空格"
        return ""
    }
    readonly property bool ready: urlText !== "" && idText !== "" && keyText !== "" && problem === ""

    // ---- now ----
    ColumnLayout {
        Layout.fillWidth: true
        spacing: Theme.s2
        RowLayout {
            spacing: Theme.s2
            Rectangle { width: Theme.px(8); height: Theme.px(8); radius: Theme.px(4); color: root.connected ? Theme.success : Theme.warning }
            PText { objectName: "modelState"; text: root.connected ? "已连接" : "未连接"; variant: "subhead"; bold: true }
        }
        GridLayout {
            visible: !!root.info.modelId
            columns: 2
            columnSpacing: Theme.s4
            rowSpacing: Theme.s1
            PText { text: "模型"; tone: "secondary" }
            PText { objectName: "modelCurrentId"; text: root.info.modelId || ""; mono: true }
            PText { text: "接口"; tone: "secondary" }
            PText { text: root.info.provider === "openai-compatible" ? "OpenAI 兼容" : (root.info.provider || ""); }
            PText { visible: root.info.mode === "faux"; text: "方式"; tone: "secondary" }
            PText { visible: root.info.mode === "faux"; text: "内置演示模型（不联网）" }
        }
        PText {
            visible: !root.connected && !!root.info.diagnostic
            Layout.fillWidth: true
            text: root.info.diagnostic || ""
            variant: "caption"; tone: "muted"; mono: true
        }
    }

    Rectangle { Layout.fillWidth: true; Layout.topMargin: Theme.s2; height: Theme.borderThin; color: Theme.border }

    // ---- connect ----
    ColumnLayout {
        Layout.fillWidth: true
        Layout.maximumWidth: Theme.px(560)
        spacing: Theme.s3
        PText { text: root.connected ? "更换模型" : "连接模型"; variant: "subhead"; bold: true }
        PText {
            Layout.fillWidth: true
            text: "支持任何 OpenAI 兼容接口。密钥只写入这个工作区，不会出现在日志、备份或导出中。"
            tone: "secondary"
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: Theme.s1
            PText { text: "接口地址"; variant: "caption"; tone: "secondary" }
            AField { id: baseUrl; objectName: "modelBaseUrl"; label: "接口地址"; placeholder: "https://api.example.com/v1"; Layout.fillWidth: true; enabled: root.owner
                onBoundValueChanged: if (root.fieldsReady && !root.prefilling) root.urlEdited = true
                onScopeReset: root.urlEdited = false }
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: Theme.s1
            PText { text: "模型 ID"; variant: "caption"; tone: "secondary" }
            AField { id: modelId; objectName: "modelIdField"; label: "模型 ID"; placeholder: "例如 gpt-4.1-mini"; Layout.fillWidth: true; enabled: root.owner
                onBoundValueChanged: if (root.fieldsReady && !root.prefilling) root.idEdited = true
                onScopeReset: root.idEdited = false }
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: Theme.s1
            PText { text: "API 密钥"; variant: "caption"; tone: "secondary" }
            AField { id: apiKey; objectName: "modelApiKey"; label: "API 密钥"; sensitive: true; placeholder: root.connected ? "输入新密钥以更换" : "sk-…"; Layout.fillWidth: true; enabled: root.owner }
        }
        PText { objectName: "modelFormHint"; visible: root.problem !== ""; Layout.fillWidth: true; text: root.problem; variant: "caption"; tone: "danger" }
        PText { visible: !root.owner; Layout.fillWidth: true; text: "只有工作区所有者可以更改模型。"; variant: "caption"; tone: "warning" }
        RowLayout {
            spacing: Theme.s2
            AButton {
                objectName: "modelSave"
                label: "保存并连接"
                variant: "primary"
                writeAction: true
                enabled: root.owner && root.ready && !shell.readOnly
                onConfirmed: {
                    shell.hardwareSecret("workspaces.modelCredential.set",
                                         {workspaceId: shell.workspaceId, provider: root.provider, modelId: root.idText, baseUrl: root.urlText},
                                         apiKey.boundValue)
                    apiKey.boundValue = ""
                }
            }
            PText { text: "需要系统确认；工作区服务随后重启以载入新模型。"; variant: "caption"; tone: "muted"; Layout.fillWidth: true }
        }
    }
    ActionsList { prefix: "machine." }
}
