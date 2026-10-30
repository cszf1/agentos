#pragma once
class QGuiApplication;
class QImage;
namespace agentos {
/** --health-canvas: fixed canvas, synthetic keyboard input, one frame checked non-blank; exit 0 on success. */
int runHealthCanvas(QGuiApplication& app, int timeoutMs);
/** Checks an image is not blank: enough distinct colors and non-background pixels. */
bool imageLooksRendered(const QImage& img, int* distinctColors = nullptr, double* inkRatio = nullptr);
}
