#include "chart_item.hpp"

#include <QPainter>
#include <QPainterPath>

namespace agentos {

static const char* kColors[] = {"#3b6fd8", "#d8833b", "#3ba86b", "#a83b8f", "#8f8f3b", "#3b9fa8", "#a83b3b", "#6b6b6b"};

ChartItem::ChartItem(QQuickItem* parent) : QQuickPaintedItem(parent) {
  setAntialiasing(true);
  connect(this, &ChartItem::changed, this, [this] { update(); });
}

QString ChartItem::color(int i) { return QString::fromLatin1(kColors[std::clamp(i, 0, 7)]); }
void ChartItem::setKind(const QString& k) {
  if (k == kind_) return;
  kind_ = k;
  emit changed();
}
void ChartItem::setXs(const QStringList& x) {
  xs_ = x.mid(0, 500);
  emit changed();
}
void ChartItem::setSeries(const QVariantList& s) {
  series_ = s.mid(0, 8);
  emit changed();
}
void ChartItem::setMaxValue(double m) {
  max_ = m > 0 ? m : 1;
  emit changed();
}
int ChartItem::pointCount() const {
  int n = 0;
  for (const auto& s : series_) n += int(std::min<qsizetype>(500, s.toMap().value(QStringLiteral("values")).toList().size()));
  return n;
}

void ChartItem::paint(QPainter* p) {
  const QRectF r = boundingRect().adjusted(28, 8, -8, -20);
  p->fillRect(boundingRect(), QColor(QStringLiteral("#ffffff")));
  p->setPen(QColor(QStringLiteral("#999999")));
  p->drawLine(r.bottomLeft(), r.bottomRight());
  p->drawLine(r.bottomLeft(), r.topLeft());
  const int n = int(xs_.size());
  if (n == 0 || series_.isEmpty()) return;
  const double bw = r.width() / n;
  const int ns = int(series_.size());
  for (int si = 0; si < ns; ++si) {
    const QVariantList vals = series_[si].toMap().value(QStringLiteral("values")).toList();
    QColor c(QString::fromLatin1(kColors[si]));
    if (kind_ == QLatin1String("LineChart")) {
      QPainterPath path;
      for (int i = 0; i < std::min<int>(n, int(vals.size())); ++i) {
        const double v = vals[i].toDouble();
        QPointF pt(r.left() + i * bw + bw / 2, r.bottom() - (v / max_) * (r.height() - 4));
        if (i == 0) path.moveTo(pt);
        else path.lineTo(pt);
      }
      p->setPen(QPen(c, 2));
      p->drawPath(path);
    } else {
      const double w = std::max(1.0, bw / ns - 2);
      for (int i = 0; i < std::min<int>(n, int(vals.size())); ++i) {
        const double v = vals[i].toDouble();
        const double h = (std::max(0.0, v) / max_) * (r.height() - 4);
        p->fillRect(QRectF(r.left() + i * bw + si * (w + 2) + 1, r.bottom() - h, w, h), c);
      }
    }
  }
  if (n <= 24) {
    p->setPen(QColor(QStringLiteral("#333333")));
    QFont f = p->font();
    f.setPixelSize(10);
    p->setFont(f);
    for (int i = 0; i < n; ++i) p->drawText(QRectF(r.left() + i * bw, r.bottom() + 2, bw, 16), Qt::AlignHCenter | Qt::TextSingleLine, xs_[i]);
  }
}

}  // namespace agentos
