import { robustZScore } from "./stats.ts"

// Content integrity detector.
//
// The failure mode this exists for: the site returns 200, responds fast,
// serves normal traffic volume, and has been quietly injected with spam SEO
// markup. Every other detector in this codebase reports it as healthy, because
// by every signal they measure, it is.
//
// Two independent checks, deliberately weighted very differently:
//
//   forbidden terms  → critical. A term from the operator's own blocklist
//                      appearing in the page is not a statistical judgement;
//                      it is a fact, and it means someone else is writing to
//                      the site.
//
//   body size        → warning, via the same median+MAD machinery the traffic
//                      detector uses. Catches blank and truncated pages that
//                      still answer 200 — a render failure `expectText` misses
//                      whenever the expected string happens to survive.
//
// The size check needs BOTH a z-guard and a relative-change guard, for the
// same reason `evaluateTraffic` has three gates. HTML byte size is extremely
// self-consistent — a news homepage's MAD is a few hundred bytes on a 100 KB
// page — so a perfectly ordinary 3% swing scores z > 4 and would alert. z
// alone says "unusual for this page"; the relative gate is what says "and
// also large enough to be a broken page rather than one more headline".
//
// What this deliberately does NOT do is alert on the body hash changing. For
// a news portal the HTML changes every minute; hash-change alerting would fire
// continuously and be muted inside a week, taking the useful checks with it.
// The hash is recorded for forensics, not for triggering.

export interface ContentDetectorOptions {
  /** z threshold for the body-size check. Reuses the monitor's spikeZ. */
  spikeZ: number
  /**
   * Fractional change from the median the size must ALSO clear, 0..1.
   * Without this the check fires on ordinary page-to-page variation.
   */
  minRelativeChange: number
  /** Below this many baseline samples, the size check stays silent. */
  minSamples: number
}

export interface ContentInput {
  /** Blocklist terms actually found in the body, in config order. */
  forbidHits: readonly string[]
  /** Byte length of the response body. */
  bodyBytes: number
  /** Prior body sizes for this monitor, most recent first. */
  bodyBytesBaseline: readonly number[]
}

export type ContentSeverity = "warning" | "critical" | null

export interface ContentFinding {
  kind: "forbidden" | "size"
  severity: Exclude<ContentSeverity, null>
  message: string
  meta: Record<string, unknown>
}

export interface ContentResult {
  findings: ContentFinding[]
}

/** Cap on how much matched text ends up in an alert body — these go to WhatsApp. */
const MAX_TERMS_IN_MESSAGE = 5

export function evaluateContent(
  input: ContentInput,
  opts: ContentDetectorOptions,
): ContentResult {
  const findings: ContentFinding[] = []

  if (input.forbidHits.length > 0) {
    const shown = input.forbidHits.slice(0, MAX_TERMS_IN_MESSAGE)
    const extra = input.forbidHits.length - shown.length
    findings.push({
      kind: "forbidden",
      severity: "critical",
      message:
        `page contains blocked ${input.forbidHits.length === 1 ? "term" : "terms"}: ` +
        shown.map((t) => `"${truncate(t, 40)}"`).join(", ") +
        (extra > 0 ? ` (+${extra} more)` : ""),
      meta: { terms: shown, totalHits: input.forbidHits.length },
    })
  }

  // Size check. Guarded on sample count for the same reason the traffic
  // detector is: a z-score over three points is not a measurement.
  if (input.bodyBytesBaseline.length >= opts.minSamples) {
    const z = robustZScore(input.bodyBytes, input.bodyBytesBaseline)
    const relativeChange =
      z.median > 0 ? Math.abs(input.bodyBytes - z.median) / z.median : 0
    if (
      Math.abs(z.z) >= opts.spikeZ &&
      relativeChange >= opts.minRelativeChange
    ) {
      const direction = z.z < 0 ? "smaller" : "larger"
      findings.push({
        kind: "size",
        severity: "warning",
        message:
          `response body is ${direction} than usual — ${formatBytes(input.bodyBytes)} ` +
          `against a typical ${formatBytes(z.median)} ` +
          `(${(relativeChange * 100).toFixed(0)}% off, z=${z.z.toFixed(2)})`,
        meta: {
          bodyBytes: input.bodyBytes,
          median: z.median,
          z: z.z,
          relativeChange,
          direction,
        },
      })
    }
  }

  return { findings }
}

/**
 * Scan a body for blocklist terms. Case-insensitive, because injected spam
 * varies casing freely and an operator writing "slot" should not have to also
 * write "SLOT" and "Slot".
 */
export function findForbidden(
  body: string,
  forbidText: readonly string[],
): string[] {
  if (forbidText.length === 0) return []
  const haystack = body.toLowerCase()
  return forbidText.filter((term) => {
    const needle = term.trim().toLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
