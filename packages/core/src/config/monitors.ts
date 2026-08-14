import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnv } from "./env.ts";

const HHMM = /^\d{2}:\d{2}$/;

const MaintenanceWindowSchema = z.object({
  start: z.string().regex(HHMM, "expected HH:MM"),
  end: z.string().regex(HHMM, "expected HH:MM"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
});

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
