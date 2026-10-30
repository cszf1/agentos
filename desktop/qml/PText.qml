import QtQuick
// The only way generated values reach the screen: plain text, never rich text auto-detection.
Text {
    property string variant: "body"
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    color: variant === "muted" ? "#5f6368" : "#1f1f1f"
    font.pixelSize: (variant === "title" ? 18 : variant === "small" ? 12 : 14) * (typeof shell !== "undefined" && shell ? shell.uiScale : 1)
    font.bold: variant === "title"
    Accessible.role: Accessible.StaticText
    Accessible.name: text
}
