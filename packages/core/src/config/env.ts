import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_URL: z.string().default("./data/night-watch.db"),
  MONITORS_CONFIG_PATH: z.string().default("./config/monitors.json"),
  // Collector credentials — optional so seed/dev workflows work with none.
  // The collector CLI validates presence for the monitors that actually
  // require them and skips gracefully otherwise.
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  GA4_SERVICE_ACCOUNT_KEY_PATH: z.string().optional(),

  // Alert channel config — all optional. Channels advertise ready()=false when
  // their prerequisites are missing; the engine skips them instead of throwing.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
  WA_GROUP_JID: z.string().optional(),
  WA_AUTH_DIR: z.string().default("./apps/worker/auth_wa"),

  // Alert engine tuning.
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(15),
  ALERT_NOTIFY_ON_RESOLVE: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
});

export type Env = z.infer<typeof EnvSchema>;

// Anchor relative paths to the workspace root so `web`, `worker`, and
// `db:migrate` all reach the same SQLite file regardless of cwd.
const WORKSPACE_ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

function findWorkspaceRoot(startFrom: string): string {
  let dir = startFrom;
  // Walk up until we find a package.json with a "workspaces" field.
  while (true) {
    const pkg = resolve(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as {
          workspaces?: unknown;
        };
        if (parsed.workspaces) return dir;
      } catch {
        // fall through
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find workspace root while walking up from ${startFrom}`,
      );
    }
    dir = parent;
  }
}

function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(WORKSPACE_ROOT, p);
}

/**
 * Load `.env` from the workspace root into `process.env`. Bun autoloads
 * from cwd, but our npm scripts `cd` into per-workspace folders, so the
 * root `.env` would otherwise be invisible from `packages/core/`.
 * Existing env vars win — respect explicit `X=y bun run …`.
 */
function loadDotEnvFromRoot(): void {
  const path = resolve(WORKSPACE_ROOT, ".env");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  loadDotEnvFromRoot();
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const raw = result.data;
  cached = {
    ...raw,
    DATABASE_URL: resolveFromRoot(raw.DATABASE_URL),
    MONITORS_CONFIG_PATH: resolveFromRoot(raw.MONITORS_CONFIG_PATH),
    WA_AUTH_DIR: resolveFromRoot(raw.WA_AUTH_DIR),
    GA4_SERVICE_ACCOUNT_KEY_PATH: raw.GA4_SERVICE_ACCOUNT_KEY_PATH
      ? resolveFromRoot(raw.GA4_SERVICE_ACCOUNT_KEY_PATH)
      : undefined,
  };
  return cached;
}

export function workspaceRoot(): string {
  return WORKSPACE_ROOT;
}

// Test-only: reset the cached env between test runs.
export function _resetEnvCacheForTests(): void {
  cached = null;
}
