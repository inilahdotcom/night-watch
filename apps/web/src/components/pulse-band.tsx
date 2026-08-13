import type { SeriesPoint } from "@night-watch/core/web";

// The signature element (brief §7). One thin vertical bar per 5-minute bucket
// over the last 6 hours (~72 bars). A darker horizontal band behind marks the
// "normal" range (P15–P85 of the shown window). Bars outside the band are
// coloured — anomalies read at a glance.
//
// Direct SVG rendering — no chart library. The shape is too simple to justify
// recharts and DOM-native output stays crisp on high-DPI phones.

interface Props {
  series: SeriesPoint[];
  /** Fixed height in px. */
  height?: number;
  /** Max bars — clamps the trailing window. */
  maxBars?: number;
  /** Colour override (default = muted foreground). */
  color?: string;
  anomalyColor?: string;
}

const DEFAULT_HEIGHT = 48;
const DEFAULT_MAX_BARS = 72; // 6h @ 5m
const BAR_GAP = 1;
const BAR_MIN_HEIGHT = 2;

export function PulseBand({
  series,
  height = DEFAULT_HEIGHT,
  maxBars = DEFAULT_MAX_BARS,
  color = "var(--muted-foreground)",
  anomalyColor = "var(--status-warning)",
}: Props) {
  if (series.length === 0) {
    return (
      <div
        className="grid place-items-center rounded-md bg-secondary/30 text-xs text-muted-foreground"
        style={{ height }}
      >
        no data yet
      </div>
    );
  }

  // Take the trailing `maxBars` points, sorted ascending by bucketTs.
  const points = series.slice(-maxBars);
  const n = points.length;
  const values = points.map((p) => p.value);
  const sorted = [...values].sort((a, b) => a - b);
  const p15 = percentile(sorted, 0.15);
  const p85 = percentile(sorted, 0.85);
  const max = Math.max(...values, 1);

  const width = 320;
  const barSlot = (width - BAR_GAP * (n - 1)) / n;

  // Y-axis: 0 at bottom, max at top; SVG y-axis is flipped so translate.
  const yFor = (v: number): number => height - (v / max) * height;

  // Convert P15–P85 range into rect coords.
  const bandY = yFor(p85);
  const bandHeight = yFor(p15) - bandY;

  return (
    <svg
      role="img"
      aria-label={`Pulse of requests over the last ${maxBars} buckets`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
    >
      {/* Normal-range band */}
      <rect
        x={0}
        y={bandY}
        width={width}
        height={Math.max(bandHeight, 1)}
        fill="var(--muted-foreground)"
        opacity={0.08}
      />
      {/* Bars */}
      {points.map((p, i) => {
        const barHeight = Math.max((p.value / max) * height, BAR_MIN_HEIGHT);
        const barY = height - barHeight;
        const isAnomaly = p.value < p15 || p.value > p85;
        return (
          <rect
            key={p.bucketTs}
            x={i * (barSlot + BAR_GAP)}
            y={barY}
            width={barSlot}
            height={barHeight}
            fill={isAnomaly ? anomalyColor : color}
            opacity={isAnomaly ? 0.95 : 0.65}
          />
        );
      })}
    </svg>
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}
