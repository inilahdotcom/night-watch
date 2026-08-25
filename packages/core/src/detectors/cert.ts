// Certificate expiry detector.
//
// The simplest detector in the codebase, and deliberately so: a certificate
// has a known expiry date, so there is no baseline to gather and no
// statistics to run. Two thresholds and a countdown.
//
// It still lives here rather than inline in the analysis cycle for the same
// reason every other detector does — pure input, pure output, testable
// without a database.

export interface CertDetectorOptions {
  /** Warn at or below this many days remaining. */
  certWarnDays: number
  /** Escalate to critical at or below this many days remaining. */
  certCritDays: number
}

export type CertSeverity = "warning" | "critical" | null

export interface CertResult {
  severity: CertSeverity
  daysLeft: number
  /** Human phrasing of the countdown, reused verbatim in the alert body. */
  message: string
}

export function evaluateCert(
  daysLeft: number,
  opts: CertDetectorOptions,
): CertResult {
  // An already-expired certificate is critical regardless of how the
  // thresholds are tuned — there is no configuration under which serving an
  // expired cert is merely a warning.
  if (daysLeft < 0) {
    return {
      severity: "critical",
      daysLeft,
      message: `certificate expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`,
    }
  }

  const message =
    daysLeft === 0
      ? "certificate expires today"
      : `certificate expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`

  if (daysLeft <= opts.certCritDays) {
    return { severity: "critical", daysLeft, message }
  }
  if (daysLeft <= opts.certWarnDays) {
    return { severity: "warning", daysLeft, message }
  }
  return { severity: null, daysLeft, message }
}
