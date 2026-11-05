import QtQuick

Text {
    id: root
    // Size ladder: "caption" (12) | "body" (14) | "subhead" (16) | "title" (20) | "display" (28)
    property string variant: "body"
    // Color semantic tone: "primary" | "secondary" | "muted" | "accent" | "danger" | "warning" | "success" | "onAccent"
    property string tone: "primary"
    property bool bold: false
    property bool mono: false

    font.family: mono ? Theme.monoFamily : Theme.fontFamily
    font.pixelSize: {
        if (variant === "small") return Theme.textCaption
        if (variant === "caption") return Theme.textCaption
        if (variant === "subhead") return Theme.textSubhead
        if (variant === "title")   return Theme.textTitle
        if (variant === "display") return Theme.textDisplay
        return Theme.textBody
    }
    font.weight: {
        if (bold) return Font.DemiBold
        if (variant === "title" || variant === "display") return Font.DemiBold
        if (variant === "subhead") return Font.Medium
        return Font.Normal
    }

    color: {
        if (variant === "muted") return Theme.textMuted
        if (tone === "secondary") return Theme.textSecondary
        if (tone === "muted")     return Theme.textMuted
        if (tone === "accent")    return Theme.accent
        if (tone === "danger")    return Theme.danger
        if (tone === "warning")   return Theme.warning
        if (tone === "success")   return Theme.success
        if (tone === "onAccent")  return Theme.textOnAccent
        return Theme.textPrimary
    }

    Accessible.role: Accessible.StaticText
    Accessible.name: text
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    renderType: Text.QtRendering
    Behavior on color {
        ColorAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic }
    }
}
