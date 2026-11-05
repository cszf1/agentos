pragma Singleton
import QtQuick

QtObject {
    id: theme

    // Global scale factor (0.8 .. 2.0, default 1.0)
    property real scale: typeof shell !== "undefined" && shell ? shell.uiScale : 1.0
    // Theme toggle: false = Light, true = Dark
    property bool dark: false

    // Scale helper function (preserves crisp pixel alignment)
    function px(val) {
        return Math.round(val * theme.scale)
    }

    // 8px baseline grid helper
    function grid(units) {
        return Math.round(units * 8 * theme.scale)
    }

    // Base Window dimensions
    readonly property int baseWidth: px(1280)
    readonly property int baseHeight: px(800)

    // Spacing tokens (8px grid)
    readonly property int s1: px(4)
    readonly property int s2: px(8)
    readonly property int s3: px(16)
    readonly property int s4: px(24)
    readonly property int s5: px(32)
    readonly property int s6: px(48)

    // Border radius tokens (modern rounded minimalist geometry)
    readonly property int radiusSm: px(6)
    readonly property int radiusControl: px(10)
    readonly property int radiusCard: px(14)
    readonly property int radiusModal: px(18)
    readonly property int radiusPill: px(999)

    // Border & Focus metrics
    readonly property int borderThin: Math.max(1, Math.round(1 * theme.scale))
    readonly property int focusWidth: Math.max(2, Math.round(2 * theme.scale))

    // Icon sizes (16px / 20px)
    readonly property int iconSm: px(16)
    readonly property int iconMd: px(20)

    // Animation durations (120ms - 200ms)
    readonly property int animFast: 120
    readonly property int animNormal: 160
    readonly property int animSlow: 200

    // Typography tokens
    readonly property string fontFamily: "Noto Sans CJK SC"
    readonly property string monoFamily: "DejaVu Sans Mono"
    readonly property int textCaption: px(12)
    readonly property int textBody: px(14)
    readonly property int textSubhead: px(16)
    readonly property int textTitle: px(20)
    readonly property int textDisplay: px(28)

    // Neutral Grayscale Palette + Single Accent (#2563EB) + Semantic Status Colors
    readonly property color bgApp:          dark ? "#0B0F17" : "#F8FAFC"
    readonly property color bgSurface:      dark ? "#111827" : "#FFFFFF"
    readonly property color bgSubtle:       dark ? "#1E293B" : "#F1F5F9"
    readonly property color bgMuted:        dark ? "#263349" : "#E2E8F0"
    readonly property color bgHover:        dark ? "#1F2937" : "#F1F5F9"
    readonly property color bgPressed:      dark ? "#334155" : "#E2E8F0"
    readonly property color bgElevated:     dark ? "#161F30" : "#FFFFFF"
    readonly property color bgCode:         dark ? "#090D14" : "#F1F5F9"

    // Trusted System Layer distinct colors (high-contrast security frame)
    readonly property color bgTrustedScrim: dark ? "#E605080F" : "#D90F172A"
    readonly property color bgTrustedBar:   dark ? "#1E1B4B" : "#1E293B"
    readonly property color bgTrustedCard:  dark ? "#0F172A" : "#FFFFFF"

    // Modal overlay & flat single-layer shadow simulation (software renderer safe)
    readonly property color scrimModal:     dark ? "#B3000000" : "#730F172A"
    readonly property color shadowFlat:     dark ? "#66000000" : "#140F172A"

    // Borders & Dividers (1px solid)
    readonly property color border:         dark ? "#1E293B" : "#E2E8F0"
    readonly property color borderStrong:   dark ? "#334155" : "#CBD5E1"
    readonly property color borderFocus:    "#2563EB"

    // Text hierarchy
    readonly property color textPrimary:    dark ? "#F8FAFC" : "#0F172A"
    readonly property color textSecondary:  dark ? "#94A3B8" : "#475569"
    readonly property color textMuted:      dark ? "#64748B" : "#94A3B8"
    readonly property color textOnAccent:   "#FFFFFF"
    readonly property color textOnDanger:   "#FFFFFF"

    // Single Accent (#2563EB)
    readonly property color accent:         "#2563EB"
    readonly property color accentHover:    dark ? "#3B82F6" : "#1D4ED8"
    readonly property color accentPressed:  dark ? "#1D4ED8" : "#1E40AF"
    readonly property color accentSubtle:   dark ? "#172554" : "#EFF6FF"
    readonly property color accentBorder:   dark ? "#1E40AF" : "#BFDBFE"

    // Status & Danger colors (#DC2626, #D97706, #16A34A)
    readonly property color danger:         "#DC2626"
    readonly property color dangerHover:    "#B91C1C"
    readonly property color dangerPressed:  "#991B1B"
    readonly property color dangerSubtle:   dark ? "#450A0A" : "#FEF2F2"
    readonly property color dangerBorder:   dark ? "#7F1D1D" : "#FECACA"

    readonly property color warning:        "#D97706"
    readonly property color warningSubtle:  dark ? "#451A03" : "#FFFBEB"
    readonly property color warningBorder:  dark ? "#78350F" : "#FDE68A"

    readonly property color success:        "#16A34A"
    readonly property color successSubtle:  dark ? "#052E16" : "#F0FDF4"
    readonly property color successBorder:  dark ? "#14532D" : "#BBF7D0"

    // Packaged raster icons accepted by the native QML URL guard.
    function iconSource(name, strokeHex) {
        if (!/^[A-Za-z]+$/.test(String(name))) name = "apps"
        var c = String(strokeHex || textSecondary).toUpperCase()
        var tone = "primary"
        if (c === "#FFFFFF" || c === "#FFF" || c === "#F8FAFC") tone = "white"
        else if (c === "#2563EB" || c === "#3B82F6") tone = "accent"
        else if (c === "#DC2626" || c === "#B91C1C") tone = "danger"
        else if (c === "#16A34A") tone = "success"
        else if (c === "#D97706") tone = "warning"
        else if (c === "#64748B" || c === "#475569" || c === "#94A3B8") tone = "muted"
        return "qrc:/agentos/qml/icons/" + name + "_" + tone + ".png"
    }
}
