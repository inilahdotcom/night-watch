import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { loadEnv } from "../config/env.ts";
import * as schema from "./schema.ts";

export type DB = BunSQLiteDatabase<typeof schema>;

type Handle = { db: DB; sqlite: Database };

let cached: Handle | null = null;

export function openDb(): Handle {
  if (cached) return cached;
  const env = loadEnv();
  const sqlite = new Database(env.DATABASE_URL);
  // WAL lets many readers coexist with a single writer — the exact pattern
  // web (reader) + worker (writer) needs. busy_timeout retries locked writes
  // for 5s instead of failing immediately.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  cached = { db, sqlite };
  return cached;
}

export function closeDb(): void {
  if (cached) {
    cached.sqlite.close();
    cached = null;
  }
}
