# Night Watch

Self-hosted monitoring for websites. It watches traffic, uptime, and Cloudflare firewall signals — then pushes a browser notification and a WhatsApp group message when something looks wrong.

Not a SaaS. Not a Kubernetes operator. Two long-lived processes, one SQLite file, one Docker command to bring it all up.

```
site → cloudflare + ga4 + probe   →   worker (writes DB)   →   push + whatsapp
                                            ↓
                                         web dashboard (reads DB)
```

## Table of contents

- [Quick start (Docker)](#quick-start-docker)
- [Quick start (local dev)](#quick-start-local-dev)
- [Configuring your monitors](#configuring-your-monitors)
- [Connecting Cloudflare](#connecting-cloudflare)
- [Connecting Google Analytics 4](#connecting-google-analytics-4)
- [Connecting WhatsApp](#connecting-whatsapp-baileys)
- [Setting up browser push (VAPID)](#setting-up-browser-push-vapid)
- [How Night Watch decides something is anomalous](#how-night-watch-decides-something-is-anomalous)
- [Tunable parameters](#tunable-parameters)
- [Trying the detectors against synthetic data](#trying-the-detectors-against-synthetic-data)
- [Environment reference](#environment-reference)
- [Licenses](#licenses)
- [Architecture](#architecture)
- [Notes on the stack](#notes-on-the-stack)

---

## Quick start (Docker)

Prerequisites: Docker Engine ≥ 24, and either Docker Desktop or OrbStack.

```bash
cp config/monitors.example.json config/monitors.json    # edit the URL you want to watch
cp .env.example .env                                    # add any keys you have; blanks are OK
docker compose up -d --build
```

That starts three containers:

- `migrate` runs the SQL migrations once and exits,
- `web` serves the dashboard on http://localhost:3011,
- `worker` runs the collectors, analysis, and alert engine.

Watch the logs:

```bash
docker compose logs -f worker
```

On first boot, if `WA_GROUP_JID` is set, the worker prints a WhatsApp QR to stdout — scan it once from the phone that owns the group (WhatsApp → Linked Devices → Link a Device). The session then persists in the `db-data` named volume.

Bring the stack down:

```bash
docker compose down          # keep data
docker compose down -v       # wipe the SQLite DB and WhatsApp session too
```

## Quick start (local dev)

Prerequisites: `bun` ≥ 1.3, macOS or Linux.

### 1. Install and configure

Run these once, from the repo root:

```bash
bun install

# Two config files. The example versions are checked in; the real ones
# are gitignored (they may hold API tokens).
cp config/monitors.example.json config/monitors.json
cp .env.example .env
```

Edit both:

- **`config/monitors.json`** — set the URL you want to watch. Add `cloudflareZoneId` if you want CF metrics, `ga4PropertyId` if you want GA4. See [Configuring your monitors](#configuring-your-monitors).
- **`.env`** — add `CLOUDFLARE_API_TOKEN` and/or `GA4_SERVICE_ACCOUNT_KEY_PATH`. Leave WhatsApp/VAPID blank for now if you don't have them yet — the corresponding channels advertise `isReady() = false` and the alert engine skips them cleanly.

Create the SQLite DB:

```bash
bun run db:migrate
```

### 2. Run the two processes (two terminals)

**Terminal A — dashboard:**

```bash
bun run dev:web
# opens on http://localhost:3011
```

**Terminal B — worker (long-running):**

```bash
bun run dev:worker
# leave running; Ctrl-C triggers graceful shutdown
```

The worker starts three schedulers immediately: monitor tick every minute, commands poll every 2 seconds, retention sweep daily at 04:00 WIB. First data lands within ~60 seconds.

### 3. Verify

While both are running, in a third terminal:

```bash
bun run db:collect      # manual one-shot collect (worker also does this every minute)
bun run alert:test      # end-to-end alert through every configured channel
bun run test            # 212 unit tests, ~750ms
bun run typecheck       # all 3 workspaces
```

### 4. First-day check without waiting a week

Seasonal baselines want at least a few days of history before the detector switches from the noisier 3-hour rolling fallback to the quieter seasonal path. To see the detectors in action *immediately*, synthetic data works:

```bash
bun run db:seed     # writes ~108k rows of realistic 6-week metrics with planted anomalies
bun run db:demo     # runs detectors; expect 3 caught, 2 correctly ignored, exit 0
```

The seed uses a monitor called `seed-demo` — it doesn't overwrite your real monitor's data.

### Common tasks

| I want to… | Command |
| --- | --- |
| Start the dashboard | `bun run dev:web` |
| Start the worker | `bun run dev:worker` |
| Force one collection cycle | `bun run db:collect` |
| Fire a test alert | `bun run alert:test` |
| Reseed synthetic data | `bun run db:seed && bun run db:demo` |
| Reset the database | `rm -rf data/ && bun run db:migrate` |
| Audit dependency licenses | `bun run audit:licenses` |
| Rebuild the container image | `docker compose up -d --build` |

### Where `.env` is loaded from

`.env` lives at the **repo root**, sibling to `Dockerfile` and `package.json`. Every CLI (`db:migrate`, `db:collect`, `dev:web`, `dev:worker`, `alert:test`, `db:seed`, `db:demo`) reads the same file — the config loader walks up from `packages/core/src/config/env.ts` to find the workspace root, so the file is discovered regardless of which sub-folder the command's `cd` lands in. Explicit env vars (`FOO=bar bun run …`) always win.

Everything below the [Environment](#environment-reference) section works identically in Docker and local modes; the only difference is where the DB file lives (`./data/` locally, `/data/` inside the container).

## Configuring your monitors

`config/monitors.json` is the single source of truth for what Night Watch watches. Copy `config/monitors.example.json` and edit:

```jsonc
{
  "controlUrl": "https://1.1.1.1",       // used to sanity-check outbound network when a probe fails
  "alertCooldownMinutes": 15,             // critical alerts renotify at most every N minutes
  "alertNotifyOnResolve": true,           // send a recovery message when an alert clears
  "quietHours": "22:00-07:00",            // silence WhatsApp for non-critical alerts (WIB)
  "timezone": "Asia/Jakarta",             // display timezone
  "monitors": [
    {
      "id": "example",                    // stable id; used as fingerprint prefix
      "url": "https://example.com",       // what the probe hits
      "expectStatusBelow": 400,           // anything ≥ this counts as a probe failure
      "expectText": "Example Domain",     // must appear in the body — catches "200 OK error page"
      "cloudflareZoneId": "…",            // optional; without it, no CF metrics collected
      "ga4PropertyId": "…"                // optional; without it, no GA4 metrics collected
    }
  ]
}
```

Every per-monitor field with a default (`bucketSeconds`, `spikeZ`, `minBaseline`, etc.) can be overridden. See [Tunable parameters](#tunable-parameters).

## Connecting Cloudflare

1. In the Cloudflare dashboard, create an API token with **Zone / Analytics — Read** for the zones you want to monitor.
2. Copy the zone id from the zone's overview page.
3. Add to `.env`:
   ```
   CLOUDFLARE_API_TOKEN=cf-xxxxxxxxxxxxxxxxxx
   ```
4. Add `cloudflareZoneId` to the monitor in `config/monitors.json`.

Restart the worker. The Cloudflare collector uses **one GraphQL query with four aliases** (total volume, per-status, per-cache-status, firewall events) — one round-trip per poll instead of four. Sampling correction (`count × avg.sampleInterval`) is applied automatically per brief §9. GraphQL errors surface via structured logs; a plan-limit error in one alias won't kill the poll cycle.

## Connecting Google Analytics 4

1. In Google Cloud, enable the **Google Analytics Data API** on your project.
2. Create a service account, download its JSON key file.
3. In GA4 Admin → Property Access Management, share the property with the service-account email (Viewer role is enough).
4. Mount the key file into the container (or place it locally) and add to `.env`:
   ```
   GA4_SERVICE_ACCOUNT_KEY_PATH=/config/ga4-sa.json
   ```
5. Add `ga4PropertyId` to the monitor in `config/monitors.json`.

The Realtime API returns a snapshot (active users right now, page views in the last 30 min), so every poll writes exactly one bucket-row per metric — this is intentional, per brief §9.

## Connecting WhatsApp (Baileys)

WhatsApp's official Cloud API cannot send to groups. Night Watch uses [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), which talks the WhatsApp Web protocol directly.

1. Create (or pick) a WhatsApp group. Send at least one message so it becomes discoverable.
2. Get the group's JID. Easiest: run `bun run alert:test` locally with `WA_GROUP_JID` unset — the log line will list JIDs after pairing. Or use the Baileys `groupFetchAllParticipating` helper. JIDs look like `120363...@g.us`.
3. Set in `.env`:
   ```
   WA_GROUP_JID=120363xxxxxxxxxxxx@g.us
   WA_AUTH_DIR=/data/auth_wa      # (Docker default; local dev defaults to ./apps/worker/auth_wa)
   ```
4. Boot the worker. On first run it prints a QR — pair once from WhatsApp on the phone that owns the group (Linked Devices → Link a Device). Auth persists on disk.

If the pairing ever gets revoked (`DisconnectReason.loggedOut`), the worker writes `wa:needs-relink` into `system_state` and the dashboard shows a banner. Restart the worker after clearing the auth folder to re-pair.

## Setting up browser push (VAPID)

1. Generate a keypair once, per deployment:
   ```
   bunx web-push generate-vapid-keys --json
   ```
2. Set both keys in `.env`:
   ```
   VAPID_PUBLIC_KEY=B…
   VAPID_PRIVATE_KEY=…
   VAPID_SUBJECT=mailto:you@example.com
   ```
3. Restart web + worker.
4. Open the dashboard. Click **Turn on** in the notifications panel. Your browser will ask for permission; grant it.

Push requires HTTPS in production (localhost is exempt). If you're deploying behind Caddy / nginx / a Cloudflare tunnel, terminate TLS there and set the tunnel to forward to `web:3011`.

## How Night Watch decides something is anomalous

The hard part of an alerting system isn't detecting problems — it's **not waking someone at 3am for a false alarm**. Here's the actual logic, in the order the worker applies it.

### 1. Seasonal baseline, not a static threshold

A static threshold like "alert if requests < 1000" fails at 03:00 because 03:00 is *legitimately* quiet. Instead:

- Time is bucketed into 5-minute windows (`bucketSeconds`).
- For the bucket at time T, the baseline is drawn from **the same time-of-day, one to four weeks ago** — with a ±1-bucket tolerance for slightly misaligned ingestion. Tuesday 14:00 gets compared to Tuesday 14:00 of previous weeks.
- If fewer than `minSamples` seasonal points exist yet (fresh install, first week), the detector **falls back to a 3-hour rolling window** ending just before T. Noisier, but functional on day one.

### 2. Robust statistics (median + MAD), not mean + stddev

If last week had an incident, a mean-based baseline is contaminated and the threshold quietly stretches — so *this* week's incident slips through undetected. Median and MAD (median absolute deviation) don't budge on a few outliers.

The z-score used is `0.6745 × (value − median) / MAD` — the 0.6745 makes the units comparable to normal-distribution sigmas.

Edge cases the code handles explicitly (all are tested):

- **MAD = 0** (majority of samples identical, common at low traffic where you get runs of zeros) — falls back to average absolute deviation.
- **Both MAD and average absolute deviation = 0** (every sample identical) — floors at `max(1, |median| × 0.1)` so the division doesn't blow up to infinity.

### 3. Three guards must ALL pass before we alert

A z-score alone is not enough. Any one of these blocks the alert:

- **`|z| ≥ spikeZ`** (default 3.5) — the deviation must be statistically real.
- **`median ≥ minBaseline`** (default 50) — the baseline must be non-trivial in absolute terms. "8 visitors → 20" is statistically significant but not an incident; this guard is what prevents it.
- **`|Δ relative| ≥ minRelativeChange`** (default 0.4) — the swing must be big relative to the median (40%+). Filters out small absolute swings that get amplified by a low MAD.

### 4. Persistence: `consecutiveBuckets` in a row

Even after the three guards pass, the anomaly has to repeat for `consecutiveBuckets` periods (default 2) before it becomes an alert. A single-bucket ripple lasts one tick and clears — it isn't worth the WhatsApp buzz.

### 5. Uptime hysteresis

The probe fires every `probeIntervalSeconds` (default 60). A failure means: timeout, status ≥ `expectStatusBelow`, or `expectText` missing from the body. That last check catches the case where an origin returns a generic error page with status 200 — the response *is* HTTP-successful but the site is *effectively* broken.

- `failThreshold` (default 3) consecutive failures before the state flips to DOWN.
- `recoverThreshold` (default 2) consecutive successes before it flips back.
- **Control-URL sanity check**: if a probe fails, the worker first pings `controlUrl` (e.g. `https://1.1.1.1`). If *that* also fails, the monitor host itself is offline — the failure is discarded and no alert fires. Without this, one bad monitor-host network hiccup would fire "everything is down" for every site.
- **Slow-response warning**: latency ≥ `slowResponseMs` (default 3000) fires as a separate `warning`, often an early sign of impending downtime.

### 6. DDoS score (composite, not a single metric)

No single Cloudflare signal is definitive — volume spikes could be marketing wins; firewall activity could be a bot sweep. Night Watch adds weights per bucket:

| Signal | Weight |
| --- | ---: |
| Volume spike `z ≥ spikeZ` | 2 |
| Volume spike `z ≥ 2 × spikeZ` (extreme) | 3 |
| Firewall blocking / challenging ≥ `threatRatioCrit` (35%) of requests | 3 |
| Firewall mitigating ≥ `threatRatioWarn` (15%) of requests | 2 |
| Origin returning ≥ `errorRatio` (10%) 5xx | 2 |
| Cache miss ≥ 70% **AND** volume spike (cache-busting signature) | 2 |
| ≥ 5% of requests rate-limited (429) | 1 |

`score ≥ 3` → **warning**. `score ≥ 5` → **critical**. Below `minRequests` (default 300) the whole scorer is silent — you can't have a meaningful DDoS below 1 rps.

Volume alone tops out at 3 (extreme) — that's the warning threshold. So a spike without any firewall/origin/cache signal never fires critical. That's deliberate: a successful campaign shouldn't wake anyone.

Recovery from a DDoS alert requires **3 consecutive clean buckets** before the alert resolves — the noise floor after a real attack is high, and we don't want to flap.

### 7. Alert engine — idempotent, cooldown-aware, escalation-aware

`raiseAlert(fingerprint, …)` is called every cycle. If a matching firing alert already exists:

- Details (title, body, meta) are updated in place, **no notification is sent**.
- Re-notify happens only on **escalation** (warning → critical) or when the alert is `critical` and `ALERT_COOLDOWN_MINUTES` (default 15) has elapsed since the last send.
- The partial unique index `alerts_firing_fp ON alerts(fingerprint) WHERE status='firing'` guarantees at most one firing row per fingerprint — enforced structurally at the DB level, not by application-level locking.

`resolveAlert(fingerprint, …)` closes the alert and (if `ALERT_NOTIFY_ON_RESOLVE`) sends a recovery message to the **same channels** that received the original — so the people notified when it broke are also notified when it clears.

### 8. Quiet hours

`quietHours: "22:00-07:00"` mutes WhatsApp for non-critical alerts. Push notifications always fire — they're silent by default so they don't wake you unnecessarily. **Critical alerts break through quiet hours** on WhatsApp too. A site being down at 3am still buzzes.

## Tunable parameters

Every per-monitor detector setting has a sensible default. Override any of them in `config/monitors.json`:

| Field | Default | What it does | Change when… |
| --- | --- | --- | --- |
| `bucketSeconds` | 300 | Time bucket size | Almost never — 5 min matches Cloudflare's native bucket. |
| `baselineWeeks` | 4 | How many prior weeks to compare against | Increase for very seasonal sites; decrease for young sites. |
| `minSamples` | 6 | Below this, fall back to rolling window | Lower to bring seasonal in earlier; raise to be strict. |
| `spikeZ` | 3.5 | z-score threshold for a "real" deviation | Lower ⇒ more alerts; raise ⇒ fewer. |
| `minBaseline` | 50 | Median must exceed this for traffic alerts to fire | Raise for high-traffic sites so tiny quiet-time swings stop mattering. |
| `minRelativeChange` | 0.4 | Relative change must exceed this | Raise to filter out modest swings; lower to catch subtle drifts. |
| `consecutiveBuckets` | 2 | How many buckets a deviation must persist | Raise to reduce noise (at the cost of slower alerts). |
| `minRequests` | 300 | Below this, DDoS scorer stays silent | Raise for high-volume zones; low sites rarely see meaningful DDoS. |
| `ingestLagSeconds` | 240 | Back off this much + one bucket before analyzing | Raise if your CF plan has slow ingestion; never lower it. |
| `threatRatioCrit` | 0.35 | Firewall block/challenge ratio ⇒ crit weight | Adjust to your baseline threat rate. |
| `threatRatioWarn` | 0.15 | Firewall mitigate ratio ⇒ warn weight | Same as above. |
| `errorRatio` | 0.10 | Origin 5xx ratio ⇒ DDoS signal | Raise if your baseline 5xx is unusually high. |
| `failThreshold` | 3 | Probes-in-a-row before DOWN | Lower for critical sites; raise for flaky origins you tolerate. |
| `recoverThreshold` | 2 | Probes-in-a-row before back UP | Raise to avoid flapping. |
| `slowResponseMs` | 3000 | Latency threshold for slow warning | Match your SLA target. |
| `probeTimeoutMs` | 10000 | HTTP fetch timeout | Raise for slow APIs you monitor. |

Global settings (top-level in `monitors.json`, not per-monitor):

| Field | Default | Purpose |
| --- | --- | --- |
| `controlUrl` | `https://1.1.1.1` | Reachability probe from the monitor host itself. |
| `alertCooldownMinutes` | 15 | Minimum minutes between re-notifications of the same firing critical. |
| `alertNotifyOnResolve` | `true` | Whether to send a recovery message when an alert clears. |
| `quietHours` | `null` | WhatsApp mute window for non-critical alerts (e.g. `"22:00-07:00"`). Critical always breaks through. |
| `timezone` | `Asia/Jakarta` | Display timezone (WIB) — used for WhatsApp timestamps and quiet-hours math. |

## Trying the detectors against synthetic data

Before real credentials are wired up (or when you want a sanity check after tuning), Night Watch can generate 6 weeks of realistic Cloudflare + GA4 metrics with a handful of deliberately-planted anomalies:

```bash
bun run db:seed      # ~108k rows, ~2 seconds
bun run db:demo      # prints a per-injection verdict + quiet-bucket sanity sweep
```

The seed plants five injections in the last 24h (a real spike, a full DDoS pattern, a real drop, a single-bucket flicker, and a modest bump). The demo asserts:

- All 3 "expected alert" injections trigger.
- Both "expected silence" injections stay quiet.
- No non-injection bucket alerts.

It exits non-zero on any false positive/negative. Use it as a smoke test after touching detector code.

## Environment reference

All variables are optional; the app is honest about what it can and can't do based on what's set.

| Var | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` disables the pretty-log transport. |
| `LOG_LEVEL` | `info` | pino level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`). |
| `DATABASE_URL` | `./data/night-watch.db` | SQLite path. Absolute paths honoured; relative anchor to workspace root. |
| `MONITORS_CONFIG_PATH` | `./config/monitors.json` | Path to the monitors config that zod validates at boot. |
| `CLOUDFLARE_API_TOKEN` | (unset) | CF API token with Zone Analytics Read. Required when a monitor has `cloudflareZoneId`. |
| `GA4_SERVICE_ACCOUNT_KEY_PATH` | (unset) | Path to GA4 service-account JSON. Required when a monitor has `ga4PropertyId`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | (unset) | Generate with `bunx web-push generate-vapid-keys --json`. Both required for push. |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact URL/email required by the Web Push spec. |
| `WA_GROUP_JID` | (unset) | WhatsApp group JID (`120…@g.us`). Required for WhatsApp channel. |
| `WA_AUTH_DIR` | `./apps/worker/auth_wa` | Where Baileys persists its pairing state. Docker default: `/data/auth_wa`. |
| `ALERT_COOLDOWN_MINUTES` | 15 | Minimum minutes between re-notifications of the same firing critical. |
| `ALERT_NOTIFY_ON_RESOLVE` | `true` | Send a recovery message when an alert clears. |
| `WEB_PORT` | 3011 | Host port the dashboard container maps to (container listens on 3011 internally). |

## Licenses

All production dependencies are OSI-approved. The audit was run under this policy:

```bash
bun run audit:licenses         # concise, exits non-zero on unknown
bun run audit:licenses:md      # markdown table for the README
```

Aggregate breakdown from the last audit:

| License | Count | Category | Notable packages |
| --- | ---: | --- | --- |
| MIT | 590 | OK | @tanstack/react-*, drizzle-orm, pino, vite, zod, react, tailwindcss |
| Apache-2.0 | 37 | OK | @google-analytics/data, @whiskeysockets/baileys, qrcode-terminal, typescript |
| ISC | 30 | OK | electron-to-chromium, glob, npmlog, semver |
| BSD-3-Clause | 25 | OK | @dotenvx/*, @hapi/*, esrecurse |
| BSD-2-Clause | 12 | OK | dotenv, entities, eslint-scope, espree |
| MPL-2.0 | 3 | OK | lightningcss, lightningcss-darwin-x64, web-push |
| MIT-0 | 2 | OK | @csstools/color-helpers, @csstools/css-syntax-patches-for-csstree |
| OFL-1.1 | 2 | FONT | @fontsource-variable/geist, @fontsource-variable/geist-mono |
| CC0-1.0 | 1 | DATA | mdn-data |
| Unlicense | 1 | DATA | isbot |
| CC-BY-4.0 | 1 | ATTRIB | caniuse-lite (attribution satisfied by inclusion in this table) |
| LGPL-3.0-or-later | 1 | WEAK_COPY | @img/sharp-libvips-darwin-x64 (dynamically linked; self-hosted, not redistributed) |
| GPL-3.0 | 1 | STRONG_COPY | libsignal (transitive of Baileys; not modified, not redistributed) |
| 0BSD, Python-2.0, BlueOak-1.0.0, (MIT OR WTFPL), (BSD-2 OR MIT OR Apache-2.0) | 5 | OK | tslib, argparse, isexe, expand-template, rc |

**Notes:**

- `libsignal` (GPL-3.0) ships as a transitive dependency of `@whiskeysockets/baileys`. It's a runtime dependency of a self-hosted deployment; nobody is modifying its source or redistributing modified copies. If your redistribution model changes (SaaS, packaged product), review this obligation.
- `@img/sharp-libvips-darwin-x64` (LGPL-3.0-or-later) comes in transitively via Vite's asset pipeline and is only invoked at build time on macOS. If you build in a container from Linux, a different variant applies.
- `caniuse-lite` (CC-BY-4.0) requires attribution — the row above satisfies it.

## Architecture

```
night-watch/
├── apps/
│   ├── web/           TanStack Start dashboard (reader). Server functions in src/lib/server-fns.ts.
│   └── worker/        Bun process. croner scheduler; owns every DB write.
├── packages/
│   └── core/
│       ├── src/db/           Drizzle schema + bun:sqlite client + migrate runner
│       ├── src/config/       zod-validated env + monitors loaders
│       ├── src/detectors/    Pure functions: stats, baseline, traffic, uptime, ddos
│       ├── src/seed/         Deterministic 6-week synthetic generator + demo CLI
│       ├── src/collectors/   Cloudflare GraphQL + GA4 Realtime + HTTP probe
│       ├── src/alerts/       Alert engine + channels (push, whatsapp) + commands outbox
│       ├── src/analysis/     Per-monitor cycle + retention sweeper
│       ├── src/web/          Read/write API the dashboard is allowed to use
│       └── src/logger.ts     pino
│       └── migrations/       Hand-written .sql — applied in order by migrate.ts
├── config/                    monitors.json (edit; not in git if it holds secrets)
├── scripts/license-audit.ts   Bun-native license audit
├── data/                      SQLite lives here (gitignored)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

Two processes, one SQLite file, communicating via:

- **`commands` outbox** — web writes `{ kind: 'test_alert' | 'wa_relink' }`, worker polls every 2 seconds.
- **`system_state` key/value** — worker publishes WhatsApp connection status, QR strings, and WA-relink prompts; web reads them.

No Redis. No internal HTTP. WAL mode + `busy_timeout = 5000` on every open — many readers, one writer, share one file safely.

## Notes on the stack

- **bun workspaces + `bun test`** instead of the brief's pnpm + vitest. Vitest runs under Node and can't resolve `bun:sqlite`; `bun test` runs the same code and has API-compatible `describe/it/expect`.
- **`bun:sqlite` + `drizzle-orm/bun-sqlite`** instead of `better-sqlite3`. Bun's NAPI loader currently refuses to open `better-sqlite3` ([bun#4290](https://github.com/oven-sh/bun/issues/4290)). The bun-sqlite driver provides an equivalent surface — WAL, pragmas, transactions, prepared statements.
- **Drizzle schema is authoritative for types; the initial migration is hand-written SQL.** SQLite needs `WITHOUT ROWID` on `metrics` and a partial `UNIQUE INDEX ... WHERE status = 'firing'` on `alerts`, neither of which drizzle-kit emits cleanly. Future schema diffs can be generated with `bun run db:generate` and reviewed by hand.
- **`DATABASE_URL` and `MONITORS_CONFIG_PATH` are anchored to the workspace root**, discovered by walking up from `packages/core/src/config/env.ts` until a `package.json` with `workspaces` is found. This is why `bun run db:migrate` (from `packages/core`), `bun run dev:worker` (from `apps/worker`), and `bun run dev:web` (from `apps/web`) all reach the same SQLite file regardless of cwd.
- **@google-analytics/data is loaded via dynamic `import()`** inside the GA4 collector so the seed CLI (which never uses GA4) doesn't drag ~30MB of gRPC transitives into its boot path.
- **Fonts are self-hosted** via `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Never load from a CDN — the status page has to render precisely when the network is misbehaving.
