#pragma once
// Native chart drawing (spec §10.2): BarChart/LineChart, at most 8 series x 500 points (already capped by the
// runtime). Painted with QPainter — no SVG/HTML. The legend and a readable data table are separate plain-text items.
#include <QQuickPaintedItem>
#include <QStringList>
#include <QVariantList>

namespace agentos {

class ChartItem : public QQuickPaintedItem {
  Q_OBJECT
  Q_PROPERTY(QString kind READ kind WRITE setKind NOTIFY changed)
  Q_PROPERTY(QStringList xs READ xs WRITE setXs NOTIFY changed)
  Q_PROPERTY(QVariantList series READ series WRITE setSeries NOTIFY changed)
  Q_PROPERTY(double maxValue READ maxValue WRITE setMaxValue NOTIFY changed)
  Q_PROPERTY(int pointCount READ pointCount NOTIFY changed)
 public:
  explicit ChartItem(QQuickItem* parent = nullptr);
  void paint(QPainter* p) override;
  QString kind() const { return kind_; }
  void setKind(const QString& k);
  QStringList xs() const { return xs_; }
  void setXs(const QStringList& x);
  QVariantList series() const { return series_; }
  void setSeries(const QVariantList& s);
  double maxValue() const { return max_; }
  void setMaxValue(double m);
  int pointCount() const;
  Q_INVOKABLE static QString color(int i);

 signals:
  void changed();

 private:
  QString kind_ = QStringLiteral("BarChart");
  QStringList xs_;
  QVariantList series_;
  double max_ = 1;
};

}  // namespace agentos
