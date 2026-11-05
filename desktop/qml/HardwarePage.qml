import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "Strings.js" as Strings

PageFrame {
    id: root
    title: Strings.hardware.title
    subtitle: Strings.hardware.subtitle
    property var shellRef: typeof shell !== "undefined" ? shell : null
    readonly property var hw: shellRef ? (shellRef.capabilities.hardware || ({})) : ({})
    readonly property var ses: shellRef ? (shellRef.session || ({})) : ({})
    readonly property var audio: ses.audio || ({})
    readonly property bool audioOk: audio.available === true
    readonly property var outputs: ses.outputs && ses.outputs.length ? ses.outputs : []
    readonly property bool rebootOk: !!hw.power && (hw.power.reboot === "yes" || hw.power.reboot === "challenge")
    readonly property bool poweroffOk: !!hw.power && (hw.power.poweroff === "yes" || hw.power.poweroff === "challenge")
    readonly property var bat: hw.battery || ({})
    function formatMode(m) { return m ? m.width + "x" + m.height : "" }
    function modeOptions(o) {
        var seen = {}, result = []
        var modes = o && o.modes ? o.modes : []
        for (var i = 0; i < modes.length; i++) {
            var v = formatMode(modes[i])
            if (v && !seen[v]) { seen[v] = true; result.push({ value: v, label: v }) }
        }
        return result
    }
    // Audio settings are session-agent operations, NOT trusted machine plans.
    PText { objectName: "batteryText"; visible: !!root.bat.available
        text: root.bat.batteryPresent ? ("电量 " + Math.round(root.bat.percentage) + "%" + (root.bat.onBattery ? "，正在使用电池" : "，外接电源")) : "没有电池（外接电源）" }
    Rectangle {
        Layout.fillWidth: true; implicitHeight: audioCol.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
        ColumnLayout {
            id: audioCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s3
            PText { text: "声音"; variant: "subhead"; bold: true }
            PText { visible: !root.audioOk; text: "不可用（会话代理未提供声音能力）"; tone: "warning" }
            RowLayout {
                visible: root.audioOk; Layout.fillWidth: true; spacing: Theme.s3
                Image { source: Theme.iconSource("volume", Theme.textPrimary.toString()); sourceSize.width: Theme.iconMd; sourceSize.height: Theme.iconMd }
                PText { text: "音量 " + (root.audio.volume || 0) + "%" }
                Slider {
                    id: vol; objectName: "volumeSlider"
                    Layout.fillWidth: true; from: 0; to: 100; stepSize: 5
                    value: root.audio.volume || 0
                    focusPolicy: Qt.StrongFocus
                    Accessible.name: "音量"
                    onMoved: volSend.restart()
                    background: Rectangle {
                        x: vol.leftPadding
                        y: vol.topPadding + vol.availableHeight / 2 - height / 2
                        implicitWidth: Theme.px(180)
                        implicitHeight: Theme.px(6)
                        width: vol.availableWidth
                        height: implicitHeight
                        radius: Theme.radiusPill
                        color: Theme.bgSubtle
                        border.width: Theme.borderThin
                        border.color: Theme.border
                        Rectangle {
                            width: vol.visualPosition * parent.width
                            height: parent.height
                            radius: Theme.radiusPill
                            color: Theme.accent
                        }
                    }
                    handle: Rectangle {
                        x: vol.leftPadding + vol.visualPosition * (vol.availableWidth - width)
                        y: vol.topPadding + vol.availableHeight / 2 - height / 2
                        implicitWidth: Theme.px(18)
                        implicitHeight: Theme.px(18)
                        radius: Theme.radiusPill
                        color: vol.pressed ? Theme.accentPressed : (vol.hovered ? Theme.accentHover : Theme.accent)
                        border.width: Theme.px(2)
                        border.color: Theme.bgSurface
                        Behavior on color { ColorAnimation { duration: Theme.animFast } }
                    }
                }
                Timer { id: volSend; interval: 250; onTriggered: if (root.shellRef) root.shellRef.hardware("audio.volume.set", { percent: Math.round(vol.value) }) }
                ACheck { objectName: "muteCheck"; label: "静音"; checked: !!root.audio.muted
                    onToggled: if (root.shellRef) root.shellRef.hardware("audio.mute.set", { muted: checked })
                }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true; implicitHeight: displayCol.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
        ColumnLayout {
            id: displayCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s3
            PText { text: "显示分辨率"; variant: "subhead"; bold: true }
            PText { visible: root.outputs.length === 0; text: "不可用（显示代理未返回输出设备）"; tone: "warning" }
            Repeater {
                model: root.outputs
                delegate: RowLayout {
                    required property var modelData
                    Layout.fillWidth: true; spacing: Theme.s3
                    PText { text: modelData.name || ""; mono: true; Layout.preferredWidth: Theme.px(160) }
                    ASelect { id: modes; objectName: "displayMode:" + modelData.name
                        Layout.preferredWidth: Theme.px(190)
                        label: "分辨率"; value: root.formatMode(modelData.current); options: root.modeOptions(modelData) }
                    ASelect { id: scale; Layout.preferredWidth: Theme.px(150)
                        label: "缩放"; value: String(modelData.scale); options: [{value:"1",label:"100%"},{value:"2",label:"200%"}] }
                    AButton { objectName: "displayApply:" + modelData.name
                        label: "应用"; variant: "primary"; writeAction: true
                        onConfirmed: if (root.shellRef) root.shellRef.hardware("display.mode.set", {output: modelData.name, mode: modes.currentValue, scale: Number(scale.currentValue)}) }
                }
            }
            Rectangle {
                visible: root.shellRef && root.shellRef.displayRevertLeft > 0
                Layout.fillWidth: true; implicitHeight: revertRow.implicitHeight + Theme.s3 * 2
                radius: Theme.radiusControl; color: Theme.warningSubtle
                border.color: Theme.warningBorder; border.width: Theme.borderThin
                RowLayout {
                    id: revertRow; anchors.fill: parent; anchors.margins: Theme.s3
                    PText { Layout.fillWidth: true; text: "保留新的分辨率？" + (root.shellRef ? root.shellRef.displayRevertLeft : 0) + " 秒后自动恢复"; tone: "warning" }
                    AButton { objectName: "displayKeep"; label: "保留"; variant: "primary"; onConfirmed: if (root.shellRef) root.shellRef.keepDisplay() }
                }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true; implicitHeight: netCol.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.border; border.width: Theme.borderThin
        ColumnLayout {
            id: netCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s2
            PText { text: "网络与时间"; variant: "subhead"; bold: true }
            PText { visible: !(root.hw.network && root.hw.network.available); text: "网络设置不可用（无受信任的系统后端能力）"; tone: "muted" }
            RowLayout {
                visible: !!root.hw.network && root.hw.network.available === true
                Layout.fillWidth: true
                ASelect { id: ssid; label: "Wi-Fi"; options: (root.hw.network && root.hw.network.ssids ? root.hw.network.ssids : []).map(function(s) { return {value:s,label:s} }) }
                AField { id: wifiPass; objectName: "wifiPassword"; label: "Wi-Fi 密码"; sensitive: true; Layout.preferredWidth: Theme.px(190) }
                AButton { label: "连接"; writeAction: true; onConfirmed: {
                    if (root.shellRef) root.shellRef.hardwareSecret("network.wifi.connect", {device: root.hw.network.wifiDevice || "", ssid:ssid.currentValue}, wifiPass.boundValue)
                    wifiPass.boundValue = ""
                }}
                AButton { label: "断开"; writeAction: true; onConfirmed: if (root.shellRef) root.shellRef.hardware("network.wifi.disconnect", {device:root.hw.network.wifiDevice || ""}) }
            }
            RowLayout {
                Layout.fillWidth: true
                PText { text: "时区：" + (root.hw.time && root.hw.time.timezone ? root.hw.time.timezone : "不可用") }
                AField { id: zone; objectName: "timezoneInput"; label: "新时区"; placeholder: "Asia/Shanghai"; Layout.preferredWidth: Theme.px(185) }
                AButton { objectName: "timezoneSet"; label: "设置时区"; writeAction: true; enabled: zone.boundValue !== "" && !!root.hw.time
                    onConfirmed: if (root.shellRef) root.shellRef.hardware("time.timezone.set", {zone: zone.boundValue}) }
                AButton { objectName: "ntpEnable"; label: "开启自动对时"; writeAction: true
                    onConfirmed: if (root.shellRef) root.shellRef.hardware("time.ntp.enable", {}) }
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true; implicitHeight: powerCol.implicitHeight + Theme.s4 * 2
        color: Theme.bgSurface; radius: Theme.radiusCard; border.color: Theme.dangerBorder; border.width: Theme.borderThin
        ColumnLayout {
            id: powerCol; anchors.fill: parent; anchors.margins: Theme.s4; spacing: Theme.s3
            PText { text: "会话与电源"; variant: "subhead"; tone: "danger"; bold: true }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.s2
                AButton { label: "锁定"; onConfirmed: if (root.shellRef) root.shellRef.hardware("session.lock", {}) }
                AButton { label: "注销"; onConfirmed: if (root.shellRef) root.shellRef.hardware("session.logout", {}) }
                Item { Layout.fillWidth: true }
                AButton { objectName: "powerReboot"; label: "重启"; variant: "danger"; enabled: root.rebootOk
                    onConfirmed: if (root.shellRef) root.shellRef.hardware("power.reboot", {}) }
                AButton { objectName: "powerOff"; label: "关机"; variant: "danger"; enabled: root.poweroffOk
                    onConfirmed: if (root.shellRef) root.shellRef.hardware("power.poweroff", {}) }
            }
            PText { visible: !root.rebootOk && !root.poweroffOk; text: "不可用（系统后端拒绝了电源管理能力）"; tone: "warning" }
        }
    }
    ActionsList { prefix: "machine." }
}
