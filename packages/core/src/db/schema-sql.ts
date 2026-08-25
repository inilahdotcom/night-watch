import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Database } from "bun:sqlite"

// Applies every migration, in filename order, to a fresh database.
//
// This exists because eight test files each used to hard-code
// `0000_init.sql`, so adding a second migration silently gave every in-memory
// test DB a schema that no longer matched production — and the failure showed
// up as "no such column" in unrelated tests rather than as anything pointing
// at the migration.
//
// Deliberately no `_migrations` ledger: this is for building a schema from
// nothing. The real runner in `migrate.ts` owns the ledger, because only it
// runs against a database that might already be half-migrated.

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
)

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
}

/** Runs every migration against `sqlite`. Intended for fresh/in-memory DBs. */
export function applyAllMigrations(sqlite: Database): void {
  for (const file of migrationFiles()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  }
}
