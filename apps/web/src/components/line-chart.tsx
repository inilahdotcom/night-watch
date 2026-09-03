import { formatCount } from "./pulse-band"

// Multi-series line chart. Direct SVG — same reasoning as pulse-band: the shape
// is too simple to justify a chart library, and DOM-native output stays crisp
// on high-DPI phones.
//
// ponytail: no axes, no tooltips, no time labels beyond the two edge captions.
// Add an x-axis when someone needs to read a value off a specific bucket rather
// than read the shape.

export interface LineSeries {
  label: string
  /** CSS colour, normally a var(--…) token from styles.css. */
  color: string
  /** Dashed as a non-colour differentiator — colour alone fails WCAG 1.4.1. */
  dashed?: boolean
  /** One entry per bucket in the shared grid. `null` means no data there. */
  values: Array<number | null>
}

interface Props {
  /** Shared x-grid; every series' `values` must be this long. */
  bucketCount: number
  series: LineSeries[]
  windowHours: number
  /** Noun for the empty state and the aria-label, e.g. "bot traffic". */
  unit: string
  height?: number
}

const VIEW_WIDTH = 320
const DEFAULT_HEIGHT = 120

export function LineChart({
  bucketCount,
  series,
  windowHours,
  unit,
  height = DEFAULT_HEIGHT,
}: Props) {
  const present = series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  )

  if (bucketCount === 0 || present.length === 0) {
    return (
      <div
        className="bg-secondary/30 text-muted-foreground grid place-items-center rounded-lg text-xs"
        style={{ height }}
      >
        No {unit} recorded for this window yet
      </div>
    )
  }

  const peak = Math.max(1, ...present)
  const ceiling = peak * 1.1
  // A single bucket would divide by zero; park it mid-canvas instead.
  const xFor = (i: number): number =>
    bucketCount === 1 ? VIEW_WIDTH / 2 : (i / (bucketCount - 1)) * VIEW_WIDTH
  const yFor = (v: number): number => height - (v / ceiling) * height

  return (
    <div>
      <svg
        role="img"
        aria-label={summarise(series, unit, windowHours)}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
      >
        {series.map((s) =>
          runsOf(s.values).map((run) =>
            run.length === 1 ? (
              // A lone bucket between two gaps has no line to belong to.
              <circle
                key={`${s.label}-${run[0]!.i}`}
                cx={xFor(run[0]!.i)}
                cy={yFor(run[0]!.v)}
                r={2}
                fill={s.color}
              />
            ) : (
              <polyline
                key={`${s.label}-${run[0]!.i}`}
                points={run.map((p) => `${xFor(p.i)},${yFor(p.v)}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                strokeLinejoin="round"
                // preserveAspectRatio="none" scales the stroke along with the
                // geometry, so without this a near-vertical segment renders as
                // a wedge and a near-horizontal one as a hairline.
                vectorEffect="non-scaling-stroke"
              />
            ),
          ),
        )}
      </svg>

      <ul className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
        {series.map((s) => (
          <li
            key={s.label}
            className="text-muted-foreground flex items-center gap-1.5"
          >
            <span
              aria-hidden
              className="h-0.5 w-4 shrink-0"
              style={{ background: s.color, opacity: s.dashed ? 0.55 : 1 }}
            />
            {s.label}{" "}
            <span className="text-foreground tabular-nums">
              {formatCount(lastOf(s.values))}
            </span>
          </li>
        ))}
      </ul>

      <div className="mono text-muted-foreground mt-1 flex justify-between text-[10px]">
        <span>{windowHours}h ago</span>
        <span aria-hidden>peak {formatCount(peak)}</span>
        <span>now</span>
      </div>
    </div>
  )
}

/**
 * Contiguous runs of present values. Missing buckets break the line instead of
 * being drawn straight through — a flat segment across a collector outage is a
 * claim the data does not support.
 */
function runsOf(
  values: ReadonlyArray<number | null>,
): Array<Array<{ i: number; v: number }>> {
  const runs: Array<Array<{ i: number; v: number }>> = []
  let cur: Array<{ i: number; v: number }> = []
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) runs.push(cur)
      cur = []
    } else {
      cur.push({ i, v })
    }
  })
  if (cur.length > 0) runs.push(cur)
  return runs
}

function lastOf(values: ReadonlyArray<number | null>): number {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null) return values[i]!
  }
  return 0
}

function summarise(
  series: readonly LineSeries[],
  unit: string,
  hours: number,
): string {
  const parts = series.map((s) => `${s.label} ${formatCount(lastOf(s.values))}`)
  return `${unit} over the last ${hours} hours. Latest: ${parts.join(", ")}.`
}
