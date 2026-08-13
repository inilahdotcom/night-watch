import type { Config } from "drizzle-kit";

// Configured for schema introspection/future generation. The initial migration
// (migrations/0000_init.sql) is hand-written because we need SQLite specifics
// drizzle-kit doesn't emit — WITHOUT ROWID and a partial unique index. Future
// diffs can be generated with `bun run db:generate` and reviewed by hand.
export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./data/night-watch.db",
  },
  verbose: true,
  strict: true,
} satisfies Config;
