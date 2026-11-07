pragma Singleton
import QtQuick

// AgentOS visual language: quiet, warm neutrals, one ink accent, little chrome.
// Solid fills only (software renderer: no blur, no shader effects).
QtObject {
    id: theme

    // Global scale factor (0.75 .. 2.0, default 1.0)
    property real scale: typeof shell !== "undefined" && shell ? shell.uiScale : 1.0
    // false = Light, true = Dark
    property bool dark: false

    function px(val) { return Math.round(val * theme.scale) }
    function grid(units) { return Math.round(units * 8 * theme.scale) }

    readonly property int baseWidth: px(1280)
    readonly property int baseHeight: px(800)

    // Spacing (8 px grid)
    readonly property int s1: px(4)
    readonly property int s2: px(8)
    readonly property int s3: px(16)
    readonly property int s4: px(24)
    readonly property int s5: px(32)
    readonly property int s6: px(48)

    // Geometry
    readonly property int radiusSm: px(6)
    readonly property int radiusControl: px(10)
    readonly property int radiusCard: px(16)
    readonly property int radiusModal: px(20)
    readonly property int radiusPill: px(999)
    readonly property int borderThin: Math.max(1, Math.round(1 * theme.scale))
    readonly property int focusWidth: Math.max(2, Math.round(2 * theme.scale))
    readonly property int iconSm: px(16)
    readonly property int iconMd: px(20)
    readonly property int iconLg: px(24)

    // Shell chrome
    readonly property int topBarHeight: px(36)
    readonly property int dockItem: px(44)
    readonly property int dockPad: px(6)
    readonly property int dockGap: px(4)
    readonly property int dockMargin: px(16)
    readonly property int dockHeight: dockItem + dockPad * 2
    // Reserved below page content so the floating dock never covers it
    readonly property int dockReserve: dockHeight + dockMargin * 2
    readonly property int contentMax: px(960)

    // Motion
    readonly property int animFast: 120
    readonly property int animNormal: 180
    readonly property int animSlow: 240

    // Typography
    readonly property string fontFamily: "Noto Sans CJK SC"
    readonly property string monoFamily: "DejaVu Sans Mono"
    readonly property int textCaption: px(12)
    readonly property int textBody: px(14)
    readonly property int textSubhead: px(15)
    readonly property int textTitle: px(18)
    readonly property int textDisplay: px(24)
    readonly property int textHero: px(34)

    // Surfaces (warm neutrals)
    readonly property color bgApp:          dark ? "#0D0D0F" : "#F3F3F1"
    readonly property color bgSurface:      dark ? "#161618" : "#FFFFFF"
    readonly property color bgSubtle:       dark ? "#1C1C1F" : "#F7F7F5"
    readonly property color bgMuted:        dark ? "#26262A" : "#EAEAE7"
    readonly property color bgHover:        dark ? "#202024" : "#F1F1EE"
    readonly property color bgPressed:      dark ? "#2A2A2E" : "#E6E6E2"
    readonly property color bgElevated:     dark ? "#1A1A1D" : "#FFFFFF"
    readonly property color bgCode:         dark ? "#111113" : "#F5F5F3"

    // Trusted system layer: always a dark, unmistakable frame
    readonly property color bgTrustedScrim: dark ? "#E6050506" : "#D916161A"
    readonly property color bgTrustedBar:   dark ? "#000000" : "#18181B"
    readonly property color bgTrustedCard:  dark ? "#161618" : "#FFFFFF"

    readonly property color scrimModal:     dark ? "#B3000000" : "#5916161A"
    readonly property color shadowFlat:     dark ? "#66000000" : "#1416161A"

    // Lines
    readonly property color border:         dark ? "#242427" : "#E7E7E3"
    readonly property color borderStrong:   dark ? "#34343A" : "#D6D6D1"
    readonly property color borderFocus:    accent

    // Text
    readonly property color textPrimary:    dark ? "#F2F2F3" : "#18181B"
    readonly property color textSecondary:  dark ? "#A3A3AB" : "#5B5B63"
    readonly property color textMuted:      dark ? "#6B6B73" : "#9C9CA3"
    readonly property color textOnAccent:   dark ? "#111113" : "#FFFFFF"
    readonly property color textOnDanger:   "#FFFFFF"
    readonly property color textOnDark:     "#F2F2F3"

    // The single accent is ink: near-black in light, near-white in dark
    readonly property color accent:         dark ? "#F2F2F3" : "#1F1F23"
    readonly property color accentHover:    dark ? "#FFFFFF" : "#34343A"
    readonly property color accentPressed:  dark ? "#D9D9DC" : "#0E0E10"
    readonly property color accentSubtle:   dark ? "#26262A" : "#EDEDEA"
    readonly property color accentBorder:   dark ? "#3A3A40" : "#D6D6D1"

    // Status (desaturated)
    readonly property color danger:         dark ? "#E5675A" : "#C03A2B"
    readonly property color dangerHover:    dark ? "#EC7E73" : "#A53224"
    readonly property color dangerPressed:  dark ? "#D3554A" : "#8C2A1E"
    readonly property color dangerSubtle:   dark ? "#2A1715" : "#FBEFED"
    readonly property color dangerBorder:   dark ? "#4A2420" : "#F0CFCA"

    readonly property color warning:        dark ? "#D9A548" : "#A86A12"
    readonly property color warningSubtle:  dark ? "#2A2214" : "#FBF5EA"
    readonly property color warningBorder:  dark ? "#4A3A1C" : "#EEDDB8"

    readonly property color success:        dark ? "#6DBE8C" : "#3F7D58"
    readonly property color successSubtle:  dark ? "#13241A" : "#EEF6F1"
    readonly property color successBorder:  dark ? "#1F3D2B" : "#CFE5D8"

    // Packaged raster icons (qrc only, accepted by the native QML URL guard).
    // tone: primary | secondary | muted | accent | onaccent | white | danger | warning | success,
    // or one of this theme's colors (mapped to its tone). Each tone exists for light and dark.
    readonly property var iconTones: ["primary", "secondary", "muted", "accent", "onaccent", "white", "danger", "warning", "success"]
    function toneOf(c) {
        var s = String(c).toLowerCase()
        if (s === "onaccent" || s === "onAccent".toLowerCase()) return "onaccent"
        if (iconTones.indexOf(s) >= 0) return s
        var pairs = [[textPrimary, "primary"], [textSecondary, "secondary"], [textMuted, "muted"], [accent, "accent"],
                     [textOnAccent, "onaccent"], [textOnDark, "white"], [danger, "danger"], [warning, "warning"], [success, "success"]]
        for (var i = 0; i < pairs.length; ++i) if (String(pairs[i][0]).toLowerCase() === s) return pairs[i][1]
        if (s === "#ffffff" || s === "#fff") return "white"
        return "secondary"
    }
    function iconSource(name, tone) {
        if (!/^[A-Za-z]+$/.test(String(name))) name = "apps"
        return "qrc:/agentos/qml/icons/" + name + "_" + toneOf(tone === undefined ? "secondary" : tone) + (dark ? "_dark" : "") + ".png"
    }
}
