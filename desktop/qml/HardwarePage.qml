import QtQuick
import QtQuick.Controls.Basic
// Machine settings (spec §12.1). Machine changes (network, time, power) go through machine.actions.plan and the
// trusted confirmation; the user's own session settings (volume, mute, display mode) go to the login session agent.
// Every field is read in the shape its backend reports (machined capabilities, session agent status); a capability
// the backend does not report is shown as unavailable, never simulated. No brightness control (VMs have none).
PageFrame {
    id: hp
    title: "硬件设置"
    readonly property var hw: shell.capabilities.hardware || ({})
    readonly property var ses: shell.session || ({})
    readonly property var bat: hw.battery || ({})
    // logind's CanReboot/CanPowerOff answers: "yes", "challenge", "no" or "na"
    function can(v) { return v === "yes" || v === "challenge" }
    readonly property bool rebootOk: !!hw.power && can(hw.power.reboot)
    readonly property bool poweroffOk: !!hw.power && can(hw.power.poweroff)
    readonly property bool audioOk: !!ses.audio && ses.audio.available === true
    // a list inside the session map reaches QML as a sequence, not a JS Array: test its length, not Array.isArray
    readonly property var outputs: ses.outputs && ses.outputs.length > 0 ? ses.outputs : []
    function av(k) { return !!hw[k] && hw[k].available === true }
    function modeText(m) { return m ? m.width + "x" + m.height : "" }
    function modeOptions(o) {
        var seen = {}, out = []
        for (var i = 0; i < (o.modes || []).length; ++i) { var t = modeText(o.modes[i]); if (!seen[t]) { seen[t] = true; out.push({ value: t, label: t }) } }
        return out
    }
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
    Unavailable { visible: !hp.audioOk }
    Row { visible: hp.audioOk; spacing: 8
        PText { text: "音量 " + (ses.audio ? ses.audio.volume : 0) + "%" }
        Slider { id: vol; objectName: "volumeSlider"; from: 0; to: 100; stepSize: 5; value: ses.audio ? ses.audio.volume || 0 : 0; Accessible.name: "音量"; focusPolicy: Qt.StrongFocus
                 onMoved: volSend.restart() }
        Timer { id: volSend; interval: 250; onTriggered: shell.hardware("audio.volume.set", { percent: Math.round(vol.value) }) }
        ACheck { objectName: "muteCheck"; label: "静音"; checked: ses.audio ? !!ses.audio.muted : false; onToggled: shell.hardware("audio.mute.set", { muted: checked }) } }
    PText { text: "电池与电源"; font.bold: true }
    Unavailable { visible: !bat.available }
    PText { objectName: "batteryText"; visible: !!bat.available
            text: bat.batteryPresent ? ("电量 " + Math.round(bat.percentage) + "%" + (bat.onBattery ? "，正在使用电池" : "，外接电源")) : "没有电池（外接电源）" }
    PText { text: "时间"; font.bold: true }
    Unavailable { visible: !(hw.time && hw.time.timezone) }
    Row { visible: !!(hw.time && hw.time.timezone); spacing: 8
        PText { text: "时区：" + (hw.time ? hw.time.timezone || "" : "") }
        AField { id: tz; objectName: "timezoneInput"; label: "新时区"; width: 200 * shell.uiScale; placeholderText: "例如 Asia/Shanghai" }
        AButton { objectName: "timezoneSet"; label: "设置时区"; enabled: tz.text !== ""; onClicked: shell.hardware("time.timezone.set", { zone: tz.text }) }
        // the backend can switch network time on (time.ntp.enable) but does not report its current state
        AButton { objectName: "ntpEnable"; label: "开启自动对时"; onClicked: shell.hardware("time.ntp.enable", {}) } }
    PText { text: "显示"; font.bold: true }
    Unavailable { visible: hp.outputs.length === 0 }
    Repeater { model: hp.outputs
        delegate: Row { spacing: 8
            PText { text: modelData.name + "：" + hp.modeText(modelData.current) + " ×" + modelData.scale }
            ASelect { id: dm; objectName: "displayMode:" + modelData.name; label: "分辨率 " + modelData.name; value: hp.modeText(modelData.current); options: hp.modeOptions(modelData) }
            ASelect { id: ds; label: "缩放 " + modelData.name; value: String(modelData.scale); options: [{ value: "1", label: "100%" }, { value: "2", label: "200%" }] }
            AButton { objectName: "displayApply:" + modelData.name; label: "应用"; onClicked: shell.hardware("display.mode.set", { output: modelData.name, mode: dm.currentValue, scale: Number(ds.currentValue) }) } } }
    Rectangle { visible: shell.displayRevertLeft > 0; width: parent.width; implicitHeight: 40; color: "#fff4d6"
        Row { anchors.centerIn: parent; spacing: 8
            PText { text: "保留新的显示设置？" + shell.displayRevertLeft + " 秒后自动恢复" }
            AButton { objectName: "displayKeep"; label: "保留"; onClicked: shell.keepDisplay() } } }
    PText { text: "会话与电源"; font.bold: true }
    Row { spacing: 8
        AButton { label: "锁定"; onClicked: shell.hardware("session.lock", {}) }
        AButton { label: "注销"; onClicked: shell.hardware("session.logout", {}) }
        AButton { objectName: "powerReboot"; label: "重启"; variant: "danger"; enabled: hp.rebootOk; onConfirmed: shell.hardware("power.reboot", {}) }
        AButton { objectName: "powerOff"; label: "关机"; variant: "danger"; enabled: hp.poweroffOk; onConfirmed: shell.hardware("power.poweroff", {}) } }
    Unavailable { visible: !hp.rebootOk && !hp.poweroffOk }
    ActionsList { prefix: "machine." }
}
