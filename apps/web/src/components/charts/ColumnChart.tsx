import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp, useFormatter } from '../../lib/store.js';

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour — a validated token (`var(--color-chart-…)`), never an ad-hoc hue. */
  color: string;
}

export interface ChartPoint {
  /** The axis label under the columns — a short date. */
  label: string;
  /** Each series' height, in one unit for every series (one axis, never two). */
  values: Record<string, number>;
}

const HEIGHT = 220;
const TOP = 12;
const BOTTOM = 28;
const MAX_BAR = 24;
const GAP = 2;

/**
 * Grouped columns, drawn as plain SVG at the size they are shown (dataviz: marks-and-anatomy).
 *
 * One axis for every series, so they must share a unit; columns are at most 24 px wide with a
 * 4 px rounded data-end and a square foot on the baseline; the grid is a recessive hairline and
 * the axis text wears text tokens, never a series colour. Time reads from the start of the line,
 * so in Kurdish and Arabic the newest day is on the left (2.10.6).
 *
 * Every day is a hover, tap and keyboard target the full height of its band, and shows
 * `tooltip(index)` — the figures in both currencies, which a column's height alone cannot say.
 */
export function ColumnChart({
  series,
  points,
  tooltip,
  label,
}: {
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  tooltip: (index: number) => ReactNode;
  /** What the chart shows, for a screen reader. */
  label: string;
}) {
  const formatter = useFormatter();
  const rtl = useApp((state) => state.preferences.lang) !== 'en';
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(1, ...points.flatMap((point) => series.map((one) => point.values[one.key] ?? 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? max;
  const gutter = Math.max(...ticks.map((tick) => formatter.number(tick).length)) * 7 + 12;
  const plotWidth = Math.max(0, width - gutter);
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const band = points.length > 0 ? plotWidth / points.length : 0;
  const barWidth = Math.max(4, Math.min(MAX_BAR, (band * 0.72 - GAP * (series.length - 1)) / series.length));
  const groupWidth = barWidth * series.length + GAP * (series.length - 1);
  // The plot sits after the axis in reading order: at the right of the labels in English, at
  // their left in Kurdish and Arabic.
  const plotStart = rtl ? 0 : gutter;
  const bandStart = (index: number) => plotStart + (rtl ? points.length - 1 - index : index) * band;
  const y = (value: number) => TOP + plotHeight - (value / top) * plotHeight;
  // Label every other day on a narrow screen, so the dates never collide.
  const labelEvery = band < 34 ? 2 : 1;

  return (
    <div className="mz-chart" ref={box}>
      {width > 0 ? (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="mz-chart__grid"
                x1={plotStart}
                x2={plotStart + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                className="mz-chart__axis"
                x={rtl ? width - 4 : gutter - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                direction="ltr"
              >
                {formatter.number(tick)}
              </text>
            </g>
          ))}

          {points.map((point, index) => {
            const start = bandStart(index) + (band - groupWidth) / 2;
            return (
              <g key={point.label + index}>
                {series.map((one, position) => {
                  const value = point.values[one.key] ?? 0;
                  if (value <= 0) return null;
                  // In RTL the series order inside a group follows the reading direction too.
                  const slot = rtl ? series.length - 1 - position : position;
                  return (
                    <path
                      key={one.key}
                      d={roundedTop(start + slot * (barWidth + GAP), y(value), barWidth, TOP + plotHeight)}
                      fill={one.color}
                      opacity={active === null || active === index ? 1 : 0.45}
                    />
                  );
                })}
                {index % labelEvery === (points.length - 1) % labelEvery ? (
                  <text
                    className="mz-chart__axis"
                    x={bandStart(index) + band / 2}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                ) : null}
                {/* The hit target: the whole band, bigger than the mark (dataviz: interaction). */}
                <rect
                  className="mz-chart__hit"
                  x={bandStart(index)}
                  y={TOP}
                  width={band}
                  height={plotHeight}
                  tabIndex={0}
                  aria-label={point.label}
                  onPointerEnter={() => setActive(index)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(index)}
                />
              </g>
            );
          })}
        </svg>
      ) : null}

      {active !== null && width > 0 ? (
        <div
          className="mz-chart__tooltip"
          role="status"
          style={{
            insetInlineStart: `${Math.min(
              Math.max(0, (rtl ? width - bandStart(active) - band : bandStart(active)) + band / 2 - 90),
              Math.max(0, width - 180),
            )}px`,
          }}
        >
          {tooltip(active)}
        </div>
      ) : null}
    </div>
  );
}

/** A column with a 4 px rounded data-end and a square foot on the baseline. */
function roundedTop(x: number, top: number, width: number, baseline: number): string {
  const radius = Math.min(4, width / 2, baseline - top);
  return [
    `M${x},${baseline}`,
    `V${top + radius}`,
    `Q${x},${top} ${x + radius},${top}`,
    `H${x + width - radius}`,
    `Q${x + width},${top} ${x + width},${top + radius}`,
    `V${baseline}`,
    'Z',
  ].join(' ');
}

/** Zero and two round steps above it that clear the largest value: 0 · 2,500,000 · 5,000,000. */
export function niceTicks(max: number): number[] {
  const rough = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
  return [0, step, step * 2];
}
