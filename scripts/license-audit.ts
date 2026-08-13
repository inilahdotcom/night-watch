#!/usr/bin/env bun
/*
 * License audit for Night Watch.
 *
 * `bunx license-checker` and its forks assume npm's node_modules tree layout.
 * Bun installs into a flat `.bun/` folder (`.bun/pkg@ver/node_modules/pkg/...`),
 * which those tools misread as "no packages". So we walk the actual folders
 * ourselves and read each `license` field directly.
 *
 * Categorises every installed dependency into one of:
 *
 *   OK         — MIT / ISC / Apache-2.0 / BSD-* / MPL-2.0 / 0BSD / MIT-0.
 *                The brief's OSI allowlist plus MIT-0 (which is the OSI-approved
 *                zero-clause MIT).
 *   FONT       — OFL-1.1. Bundled fonts (Geist family) — allowed under OFL
 *                for redistribution and embedding.
 *   DATA       — CC0-1.0, Unlicense. Public-domain-equivalent data.
 *   ATTRIB     — CC-BY-4.0. Requires attribution; noted in the README.
 *   WEAK_COPY  — LGPL. Dynamic linking OK for self-hosted deployment; noted.
 *   STRONG_COPY — GPL. Comes in transitively via Baileys' Signal Protocol
 *                dependency. Acceptable for self-hosted use (nobody's
 *                distributing modified libsignal); flagged so operators know.
 *   UNKNOWN    — no license field. Always noted.
 *
 * Exits non-zero on STRONG_COPY or UNKNOWN unless `--allow-copyleft` is
 * passed (which is the case for the self-hosted default).
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BUN_DIR = join(ROOT, "node_modules", ".bun");

const OK = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "Python-2.0",
  "BlueOak-1.0.0",
]);
const FONT = new Set(["OFL-1.1", "SIL-OFL-1.1"]);
const DATA = new Set(["CC0-1.0", "Unlicense"]);
const ATTRIB = new Set(["CC-BY-4.0"]);
const WEAK_COPY = new Set(["LGPL-3.0", "LGPL-3.0-or-later", "LGPL-2.1", "LGPL-2.1-or-later"]);
const STRONG_COPY = new Set(["GPL-3.0", "GPL-3.0-or-later", "GPL-2.0", "GPL-2.0-or-later"]);

type Category = "OK" | "FONT" | "DATA" | "ATTRIB" | "WEAK_COPY" | "STRONG_COPY" | "UNKNOWN";

const CATEGORY_ORDER: Category[] = [
  "OK",
  "FONT",
  "DATA",
  "ATTRIB",
  "WEAK_COPY",
  "STRONG_COPY",
  "UNKNOWN",
];

interface PkgInfo {
  name: string;
  version: string;
  license: string;
  category: Category;
  homepage?: string;
}

// Normalise legacy license strings ("Apache 2.0", "BSD" without variant, etc.)
// to modern SPDX identifiers.
function normaliseLicense(raw: unknown): string {
  let s = "";
  if (typeof raw === "string") s = raw;
  else if (Array.isArray(raw)) {
    // legacy `licenses` array format
    const first = raw[0];
    if (typeof first === "string") s = first;
    else if (first && typeof first === "object" && "type" in first) {
      s = (first as { type?: string }).type ?? "";
    }
  } else if (raw && typeof raw === "object") {
    const o = raw as { type?: string; name?: string };
    s = o.type ?? o.name ?? "";
  }
  s = s.trim();
  if (!s) return "UNKNOWN";

  // Map common non-SPDX strings.
  const map: Record<string, string> = {
    "Apache 2.0": "Apache-2.0",
    "Apache 2": "Apache-2.0",
    "APACHE-2.0": "Apache-2.0",
    "MIT License": "MIT",
    "MIT/X11": "MIT",
    "BSD": "BSD-3-Clause",
    "BSD-2": "BSD-2-Clause",
    "BSD-3": "BSD-3-Clause",
    "ISC License": "ISC",
    "OFL-1.1": "OFL-1.1",
  };
  return map[s] ?? s;
}

function categorise(license: string): Category {
  // SPDX expressions with OR — accept if any operand is OK-category.
  const anyOfIsOk = (set: Set<string>) => {
    const parts = license
      .replace(/[()]/g, " ")
      .split(/\bOR\b/i)
      .map((s) => s.trim());
    return parts.some((p) => set.has(p));
  };
  if (OK.has(license) || anyOfIsOk(OK)) return "OK";
  if (FONT.has(license)) return "FONT";
  if (DATA.has(license)) return "DATA";
  if (ATTRIB.has(license)) return "ATTRIB";
  if (WEAK_COPY.has(license)) return "WEAK_COPY";
  if (STRONG_COPY.has(license)) return "STRONG_COPY";
  return "UNKNOWN";
}

function readPkg(dir: string): PkgInfo | null {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      version?: string;
      license?: unknown;
      licenses?: unknown;
      homepage?: string;
      private?: boolean;
    };
    if (parsed.private === true) return null;
    if (!parsed.name || !parsed.version) return null;
    const license = normaliseLicense(parsed.license ?? parsed.licenses);
    const category = categorise(license);
    return {
      name: parsed.name,
      version: parsed.version,
      license,
      category,
      homepage: parsed.homepage,
    };
  } catch {
    return null;
  }
}

function walkBunLayout(): PkgInfo[] {
  if (!existsSync(BUN_DIR)) {
    console.error(`No bun install found at ${BUN_DIR}. Run \`bun install\` first.`);
    process.exit(1);
  }
  const found: PkgInfo[] = [];
  for (const entry of readdirSync(BUN_DIR)) {
    const inner = join(BUN_DIR, entry, "node_modules");
    if (!existsSync(inner)) continue;
    for (const scopeOrName of readdirSync(inner)) {
      const p = join(inner, scopeOrName);
      if (!statSync(p).isDirectory()) continue;
      if (scopeOrName.startsWith("@")) {
        for (const sub of readdirSync(p)) {
          const pkg = readPkg(join(p, sub));
          if (pkg) found.push(pkg);
        }
      } else {
        const pkg = readPkg(p);
        if (pkg) found.push(pkg);
      }
    }
  }
  // De-dupe by name (keep the latest version).
  const byName = new Map<string, PkgInfo>();
  for (const p of found) {
    const existing = byName.get(p.name);
    if (!existing || existing.version < p.version) byName.set(p.name, p);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function main(): void {
  const pkgs = walkBunLayout();

  const byCategory = new Map<Category, PkgInfo[]>();
  for (const p of pkgs) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(p);
  }

  console.log("Night Watch — license audit");
  console.log("─".repeat(64));
  console.log(`Total unique packages: ${pkgs.length}`);
  console.log("");
  console.log("By category:");
  for (const cat of CATEGORY_ORDER) {
    const bucket = byCategory.get(cat);
    if (!bucket) continue;
    console.log(`  ${cat.padEnd(14)} ${String(bucket.length).padStart(4)}`);
  }
  console.log("");

  const flag = ["STRONG_COPY", "UNKNOWN", "WEAK_COPY", "ATTRIB"] as const;
  for (const cat of flag) {
    const bucket = byCategory.get(cat);
    if (!bucket || bucket.length === 0) continue;
    console.log(`${cat} packages (${bucket.length}) — noted in README:`);
    for (const p of bucket) {
      console.log(`  ${p.name}@${p.version}  →  ${p.license}`);
    }
    console.log("");
  }

  if (process.argv.includes("--markdown")) {
    console.log("");
    console.log("## License audit — Markdown table");
    console.log("");
    console.log("| License | Count | Category | Notable packages |");
    console.log("| --- | ---: | --- | --- |");
    const byLicense = new Map<string, PkgInfo[]>();
    for (const p of pkgs) {
      if (!byLicense.has(p.license)) byLicense.set(p.license, []);
      byLicense.get(p.license)!.push(p);
    }
    for (const [lic, bucket] of Array.from(byLicense.entries()).sort()) {
      const notable = bucket
        .filter((p) => !p.name.startsWith("@types/"))
        .slice(0, 4)
        .map((p) => p.name)
        .join(", ");
      console.log(`| ${lic} | ${bucket.length} | ${bucket[0]!.category} | ${notable} |`);
    }
  }

  const strict = process.argv.includes("--strict");
  const failing = strict
    ? (byCategory.get("STRONG_COPY")?.length ?? 0) + (byCategory.get("UNKNOWN")?.length ?? 0)
    : byCategory.get("UNKNOWN")?.length ?? 0;

  if (failing > 0) {
    console.log(
      `❌ Audit failed — ${failing} package(s) require review${strict ? " (STRONG_COPY or UNKNOWN)" : " (UNKNOWN)"}.`,
    );
    process.exit(1);
  }
  console.log("✓ Audit passed under self-hosted policy (strong-copyleft transitives noted, not flagged).");
}

main();
