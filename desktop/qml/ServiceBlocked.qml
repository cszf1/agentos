import QtQuick
import QtQuick.Layouts
import "Strings.js" as Strings

FocusScope {
    id: root
    property var shellRef: typeof shell !== "undefined" ? shell : null
    property bool forceDismissedToDiagnostics: false

    anchors.fill: parent
    visible: shellRef ? (!shellRef.connected && !shellRef.brokerAvailable && !forceDismissedToDiagnostics) : false
    z: 850

    Rectangle {
        anchors.fill: parent
        color: Theme.bgApp
    }

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - Theme.s6, Theme.px(560))
        implicitHeight: col.implicitHeight + Theme.s5 * 2
        radius: Theme.radiusModal
        color: Theme.bgSurface
        border.width: Theme.focusWidth
        border.color: Theme.danger

        ColumnLayout {
            id: col
            anchors.fill: parent
            anchors.margins: Theme.s5
            spacing: Theme.s3

            Rectangle {
                implicitWidth: badgeTxt.implicitWidth + Theme.s3
                implicitHeight: Theme.px(24)
                radius: Theme.px(4)
                color: Theme.dangerSubtle
                border.width: Theme.borderThin
                border.color: Theme.dangerBorder

                PText {
                    id: badgeTxt
                    anchors.centerIn: parent
                    text: Strings.blocked.badge
                    variant: "caption"
                    mono: true
                    tone: "danger"
                    bold: true
                }
            }

            PText {
                Layout.fillWidth: true
                text: Strings.blocked.title
                variant: "title"
                bold: true
            }

            PText {
                Layout.fillWidth: true
                text: Strings.blocked.subtitle
                variant: "body"
                tone: "secondary"
            }

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: grid.implicitHeight + Theme.s3 * 2
                radius: Theme.radiusControl
                color: Theme.bgSubtle
                border.width: Theme.borderThin
                border.color: Theme.border

                GridLayout {
                    id: grid
                    anchors.fill: parent
                    anchors.margins: Theme.s3
                    columns: 3
                    columnSpacing: Theme.s3

                    ColumnLayout {
                        spacing: Theme.px(2)
                        PText { text: Strings.blocked.hostState; variant: "caption"; tone: "secondary" }
                        PText { text: (root.shellRef && root.shellRef.hostAvailable) ? Strings.status.hostOk : Strings.status.hostDown; variant: "body"; bold: true; tone: (root.shellRef && root.shellRef.hostAvailable) ? "success" : "danger" }
                    }

                    ColumnLayout {
                        spacing: Theme.px(2)
                        PText { text: Strings.blocked.brokerState; variant: "caption"; tone: "secondary" }
                        PText { text: (root.shellRef && root.shellRef.brokerAvailable) ? Strings.status.brokerOk : Strings.status.brokerDown; variant: "body"; bold: true; tone: (root.shellRef && root.shellRef.brokerAvailable) ? "success" : "danger" }
                    }

                    ColumnLayout {
                        spacing: Theme.px(2)
                        PText { text: Strings.blocked.modelState; variant: "caption"; tone: "secondary" }
                        PText { text: (root.shellRef && root.shellRef.modelAvailable) ? Strings.status.modelOk : Strings.status.modelDown; variant: "body"; bold: true; tone: (root.shellRef && root.shellRef.modelAvailable) ? "success" : "warning" }
                    }
                }
            }

            PText {
                text: Strings.blocked.cachedNotice + (root.shellRef ? root.shellRef.cachedAt : "")
                variant: "caption"
                mono: true
                tone: "secondary"
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: Theme.s2
                spacing: Theme.s2

                AButton {
                    label: Strings.blocked.reconnectBtn
                    variant: "primary"
                    iconName: "refresh"
                    onConfirmed: {
                        if (root.shellRef) {
                            root.forceDismissedToDiagnostics = false
                            root.shellRef.reconnect()
                        }
                    }
                }

                AButton {
                    label: Strings.blocked.rebindBtn
                    variant: "secondary"
                    onConfirmed: {
                        if (root.shellRef) {
                            root.forceDismissedToDiagnostics = false
                            root.shellRef.rebind()
                        }
                    }
                }

                Item { Layout.fillWidth: true }

                AButton {
                    label: Strings.blocked.enterDiagnosticsBtn
                    variant: "secondary"
                    onConfirmed: {
                        root.forceDismissedToDiagnostics = true
                        if (root.shellRef) {
                            root.shellRef.currentPage = "diagnostics"
                        }
                    }
                }
            }
        }
    }
}
