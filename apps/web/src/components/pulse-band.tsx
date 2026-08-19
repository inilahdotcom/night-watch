import type { PulseBucket, PulseState } from "@night-watch/core/web";

// The signature element (brief §7). One thin vertical bar per bucket over the
// window, with the detector's own baseline band drawn behind it.
//
// The band used to be the P15-P85 of the displayed window, which is
// self-referential: 15% of bars are always below P15 and 15% always above P85,
// so ~30% of every chart was coloured even when the monitor was perfectly
// healthy, and none of those colours corresponded to an alert anyone received.
//
// Now the band comes from getPulse(), which runs gatherBaseline +
// evaluateTraffic with the monitor's own tuning. A coloured bar here means the
// same thing a WhatsApp message means.
//
// Direct SVG — no chart library. The shape is too simple to justify recharts,
// and DOM-native output stays crisp on high-DPI phones.

interface Props {
  buckets: PulseBucket[];
  bucketSeconds: number;
  windowHours: number;
  height?: number;
}

const DEFAULT_HEIGHT = 64;
const BAR_GAP = 1;
const BAR_MIN_HEIGHT = 2;
const VIEW_WIDTH = 320;

// Deliberately only two hues. "We cannot judge this" states render as calm as
// "normal" — the card explains them in words instead, because a colour that
// means "no verdict" is indistinguishable from one that means "fine".
const BAR_STYLE: Record<PulseState, { fill: string; opacity: number }> = {
  normal: { fill: "var(--muted-foreground)", opacity: 0.45 },
  "below-floor": { fill: "var(--muted-foreground)", opacity: 0.45 },
  "no-baseline": { fill: "var(--muted-foreground)", opacity: 0.45 },
  unevaluated: { fill: "var(--muted-foreground)", opacity: 0.18 },
  deviating: { fill: "var(--status-warning)", opacity: 0.45 },
  confirmed: { fill: "var(--status-warning)", opacity: 1 },
};

export function PulseBand({
  buckets,
  bucketSeconds,
  windowHours,
  height = DEFAULT_HEIGHT,
}: Props) {
  if (buckets.length === 0) {
    return (
      <div
        className="grid place-items-center rounded-lg bg-secondary/30 text-xs text-muted-foreground"
        style={{ height }}
      >
        No traffic data for this window yet
      </div>
    );
  }

  const n = buckets.length;

  // Scaling to the band's upper edge would be the obvious choice, but the band
  // is often far wider than the traffic (±40% of the median at minimum), which
  // squashes every bar into the bottom third for no information gained. So we
  // scale to the traffic, and guarantee only the band's *lower* edge stays in
  // frame — that edge is the one a drop has to cross. The upper edge clipping
  // off the top reads correctly as "nowhere near the ceiling".
  const maxValue = Math.max(1, ...buckets.map((b) => b.value));
  const maxLow = Math.max(0, ...buckets.map((b) => b.low ?? 0));
  const ceiling = Math.max(maxValue * 1.15, maxLow * 1.05);
  const barSlot = (VIEW_WIDTH - BAR_GAP * (n - 1)) / n;
  const xFor = (i: number): number => i * (barSlot + BAR_GAP);
  const yFor = (v: number): number => height - (v / ceiling) * height;

  const confirmedCount = buckets.filter((b) => b.state === "confirmed").length;
  const deviatingCount = buckets.filter((b) => b.state === "deviating").length;

  return (
    <div>
      <svg
        role="img"
        aria-label={summarise({
          total: buckets.length,
          confirmed: confirmedCount,
          deviating: deviatingCount,
          hours: windowHours,
          bucketSeconds,
        })}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
      >
        {/* Baseline band. Stepped, because the expected value moves with the
            time of day — a flat band would be the same lie as before. */}
        {buckets.map((b, i) =>
          b.low === null || b.high === null ? null : (
            <rect
              key={`band-${b.bucketTs}`}
              x={xFor(i)}
              y={Math.max(0, yFor(b.high))}
              width={barSlot + BAR_GAP}
              height={Math.max(
                Math.min(height, yFor(b.low)) - Math.max(0, yFor(b.high)),
                1,
              )}
              fill="var(--muted-foreground)"
              opacity={0.16}
            />
          ),
        )}

        {buckets.map((b, i) => {
          const barHeight = Math.max((b.value / ceiling) * height, BAR_MIN_HEIGHT);
          const style = BAR_STYLE[b.state];
          return (
            <rect
              key={b.bucketTs}
              x={xFor(i)}
              y={height - barHeight}
              width={barSlot}
              height={barHeight}
              fill={style.fill}
              opacity={style.opacity}
            />
          );
        })}
      </svg>

      <div className="mono mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{windowHours}h ago</span>
        <span aria-hidden>peak {formatCount(maxValue)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function summarise(args: {
  total: number;
  confirmed: number;
  deviating: number;
  hours: number;
  bucketSeconds: number;
}): string {
  const minutes = Math.round(args.bucketSeconds / 60);
  const base = `Requests per ${minutes}-minute bucket over the last ${args.hours} hours, ${args.total} buckets`;
  if (args.confirmed > 0) {
    return `${base}. ${args.confirmed} in a confirmed traffic anomaly.`;
  }
  if (args.deviating > 0) {
    return `${base}. ${args.deviating} outside the baseline but not confirmed.`;
  }
  return `${base}. All within the baseline.`;
}

export function formatCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}
