import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Strings.js" as Strings

Item {
    id: root

    // Required contract property
    property string title: ""

    // Extended properties
    property string subtitle: ""
    // "normal" | "empty" | "loading" | "error"
    property string listState: "normal"
    property string emptyTitle: Strings.common.emptyTitle
    property string emptyDesc: Strings.common.emptyDesc
    property string errorTitle: Strings.common.errorTitle
    property string errorDesc: Strings.common.errorDesc
    property bool showRefreshButton: true
    default property alias pageContent: contentColumn.data

    ScrollView {
        id: scrollView
        anchors.fill: parent
        clip: true
        contentWidth: availableWidth

        ColumnLayout {
            width: scrollView.availableWidth
            spacing: Theme.s4

            // Page Header Row
            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: Theme.s4
                Layout.leftMargin: Theme.s5
                Layout.rightMargin: Theme.s5
                spacing: Theme.s3

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.s1

                    PText {
                        text: root.title
                        variant: "display"
                        bold: true
                    }

                    PText {
                        visible: root.subtitle !== ""
                        text: root.subtitle
                        variant: "body"
                        tone: "secondary"
                        Layout.fillWidth: true
                    }
                }

                AButton {
                    visible: root.showRefreshButton
                    label: Strings.common.refresh
                    iconName: "refresh"
                    variant: "secondary"
                    onConfirmed: {
                        if (typeof shell !== "undefined" && shell) {
                            shell.refreshPage()
                        }
                    }
                }
            }

            // 1px Divider
            Rectangle {
                Layout.fillWidth: true
                Layout.leftMargin: Theme.s5
                Layout.rightMargin: Theme.s5
                height: Theme.borderThin
                color: Theme.border
            }

            // Standardized List States: Loading / Error / Empty
            Rectangle {
                visible: root.listState !== "normal"
                Layout.fillWidth: true
                Layout.leftMargin: Theme.s5
                Layout.rightMargin: Theme.s5
                Layout.preferredHeight: Theme.px(240)
                radius: Theme.radiusCard
                color: Theme.bgSurface
                border.width: Theme.borderThin
                border.color: root.listState === "error" ? Theme.dangerBorder : Theme.border

                ColumnLayout {
                    anchors.centerIn: parent
                    width: Math.min(parent.width - Theme.s5, Theme.px(420))
                    spacing: Theme.s2

                    Rectangle {
                        Layout.alignment: Qt.AlignHCenter
                        width: Theme.px(40)
                        height: Theme.px(40)
                        radius: Theme.px(20)
                        color: root.listState === "error" ? Theme.dangerSubtle : (root.listState === "loading" ? Theme.accentSubtle : Theme.bgSubtle)

                        Image {
                            anchors.centerIn: parent
                            source: Theme.iconSource(
                                root.listState === "error" ? "incidents" : (root.listState === "loading" ? "refresh" : "apps"),
                                (root.listState === "error" ? Theme.danger : (root.listState === "loading" ? Theme.accent : Theme.textSecondary)).toString()
                            )
                            sourceSize.width: Theme.iconMd
                            sourceSize.height: Theme.iconMd
                        }
                    }

                    PText {
                        Layout.alignment: Qt.AlignHCenter
                        text: root.listState === "loading" ? Strings.common.loadingTitle : (root.listState === "error" ? root.errorTitle : root.emptyTitle)
                        variant: "subhead"
                        bold: true
                        tone: root.listState === "error" ? "danger" : "primary"
                    }

                    PText {
                        Layout.fillWidth: true
                        horizontalAlignment: Text.AlignHCenter
                        text: root.listState === "loading" ? Strings.common.loadingDesc : (root.listState === "error" ? root.errorDesc : root.emptyDesc)
                        variant: "body"
                        tone: "secondary"
                    }

                    AButton {
                        visible: root.listState === "error" || root.listState === "empty"
                        Layout.alignment: Qt.AlignHCenter
                        Layout.topMargin: Theme.s1
                        label: root.listState === "error" ? Strings.common.retry : "刷新数据"
                        variant: root.listState === "error" ? "primary" : "secondary"
                        onConfirmed: {
                            if (typeof shell !== "undefined" && shell) {
                                shell.refreshPage()
                            }
                        }
                    }
                }
            }

            // Main Page Content Container
            ColumnLayout {
                id: contentColumn
                visible: root.listState === "normal"
                Layout.fillWidth: true
                Layout.leftMargin: Theme.s5
                Layout.rightMargin: Theme.s5
                Layout.bottomMargin: Theme.s5
                spacing: Theme.s4
            }
        }
    }
}
