import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnv } from "./env.ts";

const HHMM = /^\d{2}:\d{2}$/;

const MaintenanceWindowSchema = z.object({
  start: z.string().regex(HHMM, "expected HH:MM"),
  end: z.string().regex(HHMM, "expected HH:MM"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
});

const BaselineOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  /** "drop" alerts only on a fall, "spike" only on a rise, "both" on either. */
  direction: z.enum(["drop", "spike", "both"]).default("both"),
  spikeZ: z.number().positive().optional(),
  minBaseline: z.number().nonnegative().optional(),
  minRelativeChange: z.number().min(0).max(1).optional(),
  consecutiveBuckets: z.number().int().positive().optional(),
  severity: z.enum(["warning", "critical"]).default("warning"),
});

export type BaselineOverride = z.infer<typeof BaselineOverrideSchema>;

const MonitorSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  label: z.string().optional(),

  // Uptime probing
  expectStatusBelow: z.number().int().positive().default(400),
  expectText: z.string().optional(),
  probeIntervalSeconds: z.number().int().positive().default(60),
  probeTimeoutMs: z.number().int().positive().default(10_000),
  slowResponseMs: z.number().int().positive().default(3_000),
  failThreshold: z.number().int().positive().default(3),
  recoverThreshold: z.number().int().positive().default(2),

  // Detection tuning — see brief §5.
  bucketSeconds: z.number().int().positive().default(300),
  baselineWeeks: z.number().int().min(1).default(4),
  minSamples: z.number().int().positive().default(6),
  spikeZ: z.number().positive().default(3.5),
  minBaseline: z.number().nonnegative().default(50),
  minRelativeChange: z.number().min(0).max(1).default(0.4),
  consecutiveBuckets: z.number().int().positive().default(2),
  minRequests: z.number().int().nonnegative().default(300),
  ingestLagSeconds: z.number().int().nonnegative().default(240),

  // Extra baselined metrics beyond cf_requests.
  //
  // Off unless configured, deliberately. These add new alert sources, and
  // turning them on silently would change what a quiet dashboard means for
  // every existing install — and would quietly invalidate `bun run db:demo`
  // as a regression harness.
  //
  // Guards are per-metric because they are not comparable across metrics:
  // `minBaseline: 50` is sensible for request counts and meaningless for
  // milliseconds. Direction matters too — a GA4 *spike* is good news, and a
  // latency *drop* is good news; only one side of each is worth waking for.
  baselines: z
    .object({
      ga_active_users: BaselineOverrideSchema.optional(),
      latency_ms: BaselineOverrideSchema.optional(),
      cf_bytes: BaselineOverrideSchema.optional(),
    })
    .default({}),

  // Content integrity. Terms that must never appear in the page body —
  // injected SEO spam is the usual reason. Matching is case-insensitive and
  // a single hit is critical, so keep this list specific.
  forbidText: z.array(z.string().min(1)).default([]),

  // TLS certificate expiry. Defaults chosen so a 90-day Let's Encrypt cert
  // warns a full renewal cycle before it bites, and goes critical while there
  // is still a working day to fix it.
  certWarnDays: z.number().int().positive().default(14),
  certCritDays: z.number().int().nonnegative().default(3),

  // DDoS score thresholds
  threatRatioCrit: z.number().min(0).max(1).default(0.35),
  threatRatioWarn: z.number().min(0).max(1).default(0.15),
  errorRatio: z.number().min(0).max(1).default(0.1),

  // Source identifiers — optional until Stage 4 collectors ship.
  cloudflareZoneId: z.string().optional(),
  ga4PropertyId: z.string().optional(),

  // Recurring maintenance windows. Same wall-clock semantics as quietHours
  // but per-monitor and applied to ALL alerts, not just WhatsApp.
  maintenanceWindows: z.array(MaintenanceWindowSchema).default([]),
});

const QuietHoursSchema = z
  .string()
  .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "expected HH:MM-HH:MM")
  .nullable()
  .default(null);

const MonitorsConfigSchema = z.object({
  monitors: z.array(MonitorSchema).min(1),
  controlUrl: z.string().url().default("https://1.1.1.1"),
  alertCooldownMinutes: z.number().int().positive().default(15),
  alertNotifyOnResolve: z.boolean().default(true),
  quietHours: QuietHoursSchema,
  timezone: z.string().default("Asia/Jakarta"),
});

export type Monitor = z.infer<typeof MonitorSchema>;

/**
 * A Monitor carrying nothing but schema defaults.
 *
 * For tooling that has to reason about a monitor id which exists in the
 * metrics table but not in monitors.json — synthetic seed data, or a monitor
 * removed from config whose history is still around. Config stays the source
 * of truth for anything the worker acts on; this is read-only scaffolding.
 */
export function monitorDefaults(id: string, url = "https://example.invalid"): Monitor {
  return MonitorSchema.parse({ id, url });
}
export type MonitorsConfig = z.infer<typeof MonitorsConfigSchema>;

let cached: MonitorsConfig | null = null;

export function loadMonitors(): MonitorsConfig {
  if (cached) return cached;
  const env = loadEnv();
  let raw: string;
  try {
    raw = readFileSync(env.MONITORS_CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read monitors config at ${env.MONITORS_CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `monitors config at ${env.MONITORS_CONFIG_PATH} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = MonitorsConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid monitors config (${env.MONITORS_CONFIG_PATH}):\n${issues}`,
    );
  }
  cached = result.data;
  return cached;
}

// Test-only: reset the cached config between test runs.
export function _resetMonitorsCacheForTests(): void {
  cached = null;
}
