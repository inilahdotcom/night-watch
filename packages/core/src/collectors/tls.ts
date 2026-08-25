import { connect } from "node:tls"

// TLS certificate expiry probe.
//
// Deliberately separate from `probe.ts`: `fetch` gives us no access to the
// peer certificate, so reading `notAfter` means opening our own TLS socket.
// That is a real handshake, so the caller is expected to rate-limit it —
// see the once-an-hour guard in `collect.ts`. A cert does not change between
// two minutes, and doing this on every tick would mean 1440 needless
// handshakes per monitor per day.
//
// Follows the same contract as `probe()` and `checkControl()`: never throws.
// Every failure mode comes back as `{ kind: "fail", reason }`.

export type TlsResult =
  | {
      kind: "ok"
      /** Whole days until `notAfter`. Negative once expired. */
      daysLeft: number
      validTo: string
      issuer: string | null
    }
  | { kind: "fail"; reason: string }

export interface TlsOptions {
  timeoutMs: number
  /** Injected in tests. */
  connectImpl?: typeof connect
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Opens a TLS connection to `hostname:port` and reads the peer certificate.
 *
 * `rejectUnauthorized: false` is intentional and load-bearing: an expired or
 * self-signed certificate is exactly the condition we are trying to report,
 * and rejecting the handshake would throw away the `notAfter` date we came
 * for. This socket carries no request and reads no response body, so there is
 * nothing here for a bad certificate to compromise.
 */
export async function checkTls(
  hostname: string,
  port: number,
  opts: TlsOptions,
): Promise<TlsResult> {
  const connectFn = opts.connectImpl ?? connect
  const now = opts.now ?? (() => Date.now())

  return new Promise<TlsResult>((resolve) => {
    let settled = false
    const finish = (result: TlsResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // Already gone — nothing to clean up.
      }
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ kind: "fail", reason: "tls handshake timeout" }),
      opts.timeoutMs,
    )

    const socket = connectFn(
      {
        host: hostname,
        port,
        servername: hostname, // SNI — without it a shared IP serves the wrong cert
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate()
        if (!cert || !cert.valid_to) {
          finish({ kind: "fail", reason: "no peer certificate presented" })
          return
        }
        const expiresAt = Date.parse(cert.valid_to)
        if (Number.isNaN(expiresAt)) {
          finish({
            kind: "fail",
            reason: `unparseable notAfter: ${cert.valid_to}`,
          })
          return
        }
        finish({
          kind: "ok",
          // Floor, not round: 0 must mean "expires today", never "expired
          // half a day ago but rounds up to fine".
          daysLeft: Math.floor((expiresAt - now()) / DAY_MS),
          validTo: cert.valid_to,
          issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null,
        })
      },
    )

    socket.on("error", (err: Error) => {
      finish({ kind: "fail", reason: err.message })
    })
  })
}

/** Port + hostname for a monitor URL, or null when it isn't HTTPS. */
export function tlsTargetFor(
  url: string,
): { hostname: string; port: number } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") return null
    return {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 443,
    }
  } catch {
    return null
  }
}
