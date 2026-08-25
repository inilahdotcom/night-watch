import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnv } from "../config/env.ts";
import { createLogger } from "../logger.ts";
import { MIGRATIONS_DIR, migrationFiles } from "./schema-sql.ts";

function main(): void {
  const env = loadEnv();
  const log = createLogger("migrate");

  mkdirSync(dirname(env.DATABASE_URL), { recursive: true });

  const sqlite = new Database(env.DATABASE_URL);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = migrationFiles();

  const appliedRows = sqlite
    .prepare("SELECT name FROM _migrations")
    .all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((r) => r.name));

  let applyCount = 0;
  const insert = sqlite.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (applied.has(file)) {
      log.debug({ file }, "migration already applied");
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      insert.run(file, Date.now());
    });
    tx();
    applyCount += 1;
    log.info({ file }, "migration applied");
  }

  sqlite.close();
  log.info({ applied: applyCount, total: files.length }, "migrations done");
}

main();
