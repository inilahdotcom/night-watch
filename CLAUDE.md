# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Night Watch — self-hosted monitoring for websites. It collects Cloudflare Analytics, GA4 Realtime, and HTTP probe data into one SQLite file, runs anomaly detectors over it, and pushes browser notifications + WhatsApp group messages when something looks wrong.

Runtime is **Bun** (not Node). Package manager is **bun workspaces** (`bun.lock`), despite `.cta.json` claiming pnpm.

## Commands

All from the repo root:

```bash
bun install
bun run db:migrate         # create/upgrade the SQLite DB (run before anything else)
bun run dev:web            # dashboard on http://localhost:3011
bun run dev:worker         # long-running collector/detector/alerter
bun run test               # bun test in packages/core (~242 tests, <1s)
bun run typecheck          # tsc --noEmit across core + worker + web
bun run lint               # eslint
bun run format             # prettier --write
```

Single test file / single test:

```bash
cd packages/core && bun test src/detectors/__tests__/traffic.test.ts
cd packages/core && bun test --test-name-pattern "MAD"
```

Useful one-shots:

```bash
bun run db:collect         # force one collection cycle
bun run alert:test         # end-to-end alert through every configured channel
bun run db:seed            # ~108k rows of synthetic 6-week metrics w/ planted anomalies (monitor id `seed-demo`)
bun run db:demo            # run detectors against the seed; expects 3 caught, 2 ignored, exit 0
bun run wa:groups          # pair WhatsApp + list group JIDs
bun run audit:licenses     # exits non-zero on unknown licenses
rm -rf data/ && bun run db:migrate   # reset the DB
```

Docker: `docker compose up -d --build` starts `migrate` (runs once), `web`, `worker`.

## Architecture

**Two processes, one SQLite file, no Redis and no internal HTTP.**

- `apps/worker` — Bun process, croner schedulers. **Owns every DB write.** Three jobs: monitor tick (every minute: probe + CF/GA4 collect + analysis cycle per monitor), commands poll (every 2s), retention sweep (04:00 Asia/Jakarta). Ticks self-guard against overlap with a boolean flag.
- `apps/web` — TanStack Start (React 19, Vite 8, Tailwind 4) dashboard. **Reader only.**
- `packages/core` — everything else, consumed via subpath exports (`@night-watch/core/db`, `/alerts`, `/collectors`, `/analysis`, `/web`, `/config`).

The two processes talk through the DB:

- **`commands` outbox** — web enqueues `test_alert | wa_relink | snooze | unsnooze`; the worker drains it every 2s.
- **`system_state`** key/value — worker publishes WhatsApp connection state, QR strings, and per-monitor analysis state (consecutive-alarm streaks, so restarts don't lose history); web reads it.

### The reader/writer boundary is enforced by module surface

`packages/core/src/web/queries.ts` holds only SELECTs; `mutations.ts` exports only `subscribePush`, `unsubscribePush`, `enqueueCommand`. That pair is the entire write surface available to `apps/web`. If a dashboard feature needs to mutate `metrics`, `alerts`, `deliveries`, `probe_state`, or `system_state` — enqueue a command and handle it in the worker instead of widening `mutations.ts`.

`apps/web/src/lib/server-fns.ts` wraps those in TanStack `createServerFn`; components never touch the DB directly.

### Detection pipeline

`collectors/` write raw metric rows → `analysis/cycle.ts` reads mature buckets → `detectors/` (pure functions, heavily unit-tested) decide → `alerts/engine.ts` raises/resolves.

Key invariants (all documented at length in README §"How Night Watch decides something is anomalous"):

- Baselines are **seasonal** (same time-of-day, 1–4 weeks back) with a 3-hour rolling-window fallback when fewer than `minSamples` seasonal points exist.
- Statistics are **median + MAD**, not mean + stddev, so a prior incident doesn't contaminate the threshold. Zero-MAD and all-identical-samples edge cases have explicit floors in `detectors/stats.ts`.
- Three guards must **all** pass before a traffic alert: `|z| ≥ spikeZ`, `median ≥ minBaseline`, `|Δrel| ≥ minRelativeChange`. Then it must persist `consecutiveBuckets` ticks.
- Uptime uses hysteresis (`failThreshold` down / `recoverThreshold` up) plus a **control-URL sanity check** — if `controlUrl` is also unreachable, the monitor host is offline and the failure is discarded.
- DDoS is a **weighted composite score** across volume/firewall/5xx/cache-miss/429, not a single metric. Volume alone caps at the warning threshold.
- Alert fingerprints are fixed strings (`<monitor>:traffic:spike`, `:traffic:drop`, `:ddos`, `:uptime`, `:slow`). The partial unique index `alerts_firing_fp ON alerts(fingerprint) WHERE status='firing'` structurally guarantees at most one firing row per fingerprint — do not replace it with application-level locking.
- `raiseAlert` is idempotent: repeat calls update the row in place and send nothing. Re-notify happens only on escalation (warning → critical) or after `ALERT_COOLDOWN_MINUTES` for criticals.

### Channels

`NotificationChannel` is an interface with `isReady()`. Missing credentials mean a channel reports not-ready and the engine skips it cleanly — never throw at boot for absent config. Keep new channels (Telegram/Slack) behind this interface.

## Conventions and gotchas

- **`bun test`, not vitest.** Vitest runs under Node and can't resolve `bun:sqlite`. `vitest` in devDependencies is vestigial.
- **`bun:sqlite` + `drizzle-orm/bun-sqlite`**, not better-sqlite3 (Bun's NAPI loader refuses it). `openDb()` caches a single handle and sets WAL + `busy_timeout=5000` + `foreign_keys=ON`.
- **Drizzle schema is authoritative for types, but migrations are hand-written SQL** in `packages/core/migrations/`, applied in order by `migrate.ts`. SQLite needs `WITHOUT ROWID` on `metrics` and the partial unique index on `alerts`, neither of which drizzle-kit emits cleanly. `bun run db:generate` produces a diff to review by hand — don't trust its output verbatim.
- **Relative `DATABASE_URL` / `MONITORS_CONFIG_PATH` are anchored to the workspace root**, found by walking up from `packages/core/src/config/env.ts` until a `package.json` with `workspaces`. This is why every CLI reaches the same DB regardless of the `cd` in its npm script. `.env` lives at the repo root only.
- **`@google-analytics/data` is imported dynamically** inside the GA4 collector so the seed CLI doesn't pull ~30MB of gRPC transitives.
- **Fonts are self-hosted** (`@fontsource-variable/geist`). Never load from a CDN — the status page must render when the network is misbehaving.
- **Must run on a persistent runtime.** Not serverless, not edge, not Cloudflare Workers: the Baileys WhatsApp connection is a long-lived WebSocket and the schedulers run between requests. Deployment preset is `node-server`.
- Prettier: no semicolons, double quotes, 2-space, printWidth 80, with `prettier-plugin-tailwindcss` (`cn`/`cva` are tailwind functions).
- `config/monitors.json` and `.env` are gitignored; `.example` versions are checked in. Editing `monitors.json` requires a worker restart.

## Reference docs in-repo

- `README.md` — operator-facing: setup, every env var, every tunable detector parameter with defaults and when to change them, license audit table.
- `PROMPT-claude-code.md` — the original brief (Indonesian). Code comments cite it as "brief §N"; use it to understand *why* a constraint exists before relaxing it.
- `DESIGN.md` — design tokens (colors, typography scale) for the marketing/landing pages.
