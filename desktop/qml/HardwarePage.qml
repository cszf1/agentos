import QtQuick
import QtQuick.Controls.Basic
// Machine settings (spec §12.1). Every change goes through machine.actions.plan and the trusted confirmation;
// a capability the backend does not report is shown as unavailable, never simulated.
PageFrame {
    id: hp
    title: "硬件设置"
    readonly property var hw: shell.capabilities.hardware || ({})
    function av(k) { return !!hw[k] && hw[k].available === true }
    component Unavailable: PText { text: "不可用（系统后端未提供此能力）"; color: "#7a5a00" }
    PText { text: "网络"; font.bold: true }
    Unavailable { visible: !av("network") }
    Column { visible: av("network"); spacing: 6
        PText { text: "当前：" + (hw.network && hw.network.connected ? hw.network.connected : "未连接") }
        Row { spacing: 8
            ASelect { id: ssid; label: "Wi-Fi 网络"; value: ""; options: (hw.network && hw.network.ssids ? hw.network.ssids : []).map(function(s) { return { value: s, label: s } }) }
            AField { id: wifiPass; objectName: "wifiPassword"; label: "Wi-Fi 密码"; echoMode: TextInput.Password; sensitive: true; width: 180 * shell.uiScale; placeholderText: "密码（只交给系统密钥代理）" }
            // the key goes to the gateway in the request's separate secret field (never in params); machined hands it
            // to NetworkManager through its secret agent and keeps only a secretRef in the operation log
            AButton { label: "连接"; onClicked: { shell.hardwareSecret("network.wifi.connect", { device: hw.network.wifiDevice || "", ssid: ssid.currentValue }, wifiPass.text); wifiPass.text = "" } }
            AButton { label: "断开"; onClicked: shell.hardware("network.wifi.disconnect", { device: hw.network.wifiDevice || "" }) } } }
    PText { text: "声音"; font.bold: true }
    Unavailable { visible: !av("audio") }
    Row { visible: av("audio"); spacing: 8
        PText { text: "音量" }
        Slider { id: vol; from: 0; to: 100; stepSize: 5; value: hw.audio ? hw.audio.volume || 0 : 0; Accessible.name: "音量"; focusPolicy: Qt.StrongFocus; onMoved: shell.hardware("audio.volume.set", { percent: Math.round(value) }) }
        ACheck { label: "静音"; checked: hw.audio ? !!hw.audio.muted : false; onToggled: shell.hardware("audio.mute.set", { muted: checked }) }
        ASelect { label: "输出设备"; value: hw.audio ? hw.audio.output || "" : ""; options: (hw.audio && hw.audio.outputs ? hw.audio.outputs : []).map(function(o) { return { value: o, label: o } }); onChosen: function(v) { shell.hardware("audio.output.select", { output: v }) } } }
    PText { text: "亮度"; font.bold: true }
    Unavailable { visible: !av("brightness") }
    Row { visible: av("brightness"); spacing: 8
        Slider { from: 5; to: 100; stepSize: 5; value: hw.brightness ? hw.brightness.percent || 50 : 50; Accessible.name: "亮度"; focusPolicy: Qt.StrongFocus; onMoved: shell.hardware("display.brightness.set", { percent: Math.round(value) }) } }
    PText { text: "电池与电源"; font.bold: true }
    Unavailable { visible: !av("battery") }
    PText { visible: av("battery"); text: hw.battery ? ("电量 " + hw.battery.percent + "%" + (hw.battery.charging ? "，正在充电" : "") + (hw.battery.onAc ? "，外接电源" : "")) : "" }
    PText { text: "时间"; font.bold: true }
    Unavailable { visible: !av("time") }
    Row { visible: av("time"); spacing: 8
        ASelect { label: "时区"; value: hw.time ? hw.time.timezone || "" : ""; options: (hw.time && hw.time.zones ? hw.time.zones : []).map(function(z) { return { value: z, label: z } }); onChosen: function(v) { shell.hardware("time.timezone.set", { timezone: v }) } }
        PText { text: hw.time && hw.time.ntp ? "自动时间同步：开" : "自动时间同步：关" } }
    PText { text: "显示"; font.bold: true }
    Unavailable { visible: !av("display") }
    Repeater { model: av("display") ? hw.display.outputs : []
        delegate: Row { spacing: 8
            PText { text: modelData.name + "：" + modelData.current + " ×" + modelData.scale }
            ASelect { id: dm; label: "分辨率 " + modelData.name; value: modelData.current; options: modelData.modes.map(function(m) { return { value: m, label: m } }) }
            ASelect { id: ds; label: "缩放 " + modelData.name; value: String(modelData.scale); options: [{ value: "1", label: "1x" }, { value: "2", label: "2x" }] }
            AButton { label: "应用"; onClicked: shell.hardware("display.mode.set", { output: modelData.name, mode: dm.currentValue, scale: Number(ds.currentValue) }) } } }
    Rectangle { visible: shell.displayRevertLeft > 0; width: parent.width; implicitHeight: 40; color: "#fff4d6"
        Row { anchors.centerIn: parent; spacing: 8
            PText { text: "保留新的显示设置？" + shell.displayRevertLeft + " 秒后自动恢复" }
            AButton { label: "保留"; onClicked: shell.keepDisplay() } } }
    PText { text: "会话与电源"; font.bold: true }
    Row { spacing: 8
        AButton { label: "锁定"; enabled: av("session") || true; onClicked: shell.hardware("session.lock", {}) }
        AButton { label: "注销"; enabled: av("session"); onClicked: shell.hardware("session.logout", {}) }
        AButton { label: "重启"; variant: "danger"; enabled: av("power"); onClicked: shell.hardware("power.reboot", {}) }
        AButton { label: "关机"; variant: "danger"; enabled: av("power"); onClicked: shell.hardware("power.shutdown", {}) } }
    Unavailable { visible: !av("power") }
    ActionsList { prefix: "machine." }
}
