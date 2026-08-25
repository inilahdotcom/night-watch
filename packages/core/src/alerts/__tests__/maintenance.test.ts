import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyAllMigrations } from "../../db/schema-sql.ts";
import {
  clearSnooze,
  isInMaintenanceAt,
  isSnoozedNow,
  readActiveSnoozes,
  writeSnooze,
  type AdhocSnooze,
  type MaintenanceWindow,
} from "../maintenance.ts";

const WIB = 7;

// Build a WIB local time on 2026-08-13 (Thursday, dow=4) as unix seconds.
function wibTime(hh: number, mm: number, day = 13, month = 7): number {
  const utc = Date.UTC(2026, month, day, -WIB, 0, 0);
  return Math.floor(utc / 1000) + hh * 3600 + mm * 60;
}

function newDb(): Database {
  const sqlite = new Database(":memory:");
  applyAllMigrations(sqlite);
  return sqlite;
}

// -------------------------------------------------------------------------
// Recurring windows
// -------------------------------------------------------------------------

describe("isInMaintenanceAt — same-day window", () => {
  const w: MaintenanceWindow = { start: "10:00", end: "12:00" };

  it("is true inside the window", () => {
    expect(isInMaintenanceAt(wibTime(10, 0), w, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(11, 30), w, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(11, 59), w, WIB)).toBe(true);
  });

  it("is false at end (exclusive) and outside", () => {
    expect(isInMaintenanceAt(wibTime(12, 0), w, WIB)).toBe(false);
    expect(isInMaintenanceAt(wibTime(9, 59), w, WIB)).toBe(false);
    expect(isInMaintenanceAt(wibTime(15, 0), w, WIB)).toBe(false);
  });
});

describe("isInMaintenanceAt — overnight window", () => {
  const w: MaintenanceWindow = { start: "23:00", end: "02:00" };

  it("is true in the late-night portion", () => {
    expect(isInMaintenanceAt(wibTime(23, 0), w, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(23, 59), w, WIB)).toBe(true);
  });

  it("is true in the early-morning portion", () => {
    expect(isInMaintenanceAt(wibTime(0, 0), w, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(1, 59), w, WIB)).toBe(true);
  });

  it("is false at the end boundary and during the day", () => {
    expect(isInMaintenanceAt(wibTime(2, 0), w, WIB)).toBe(false);
    expect(isInMaintenanceAt(wibTime(10, 0), w, WIB)).toBe(false);
    expect(isInMaintenanceAt(wibTime(22, 59), w, WIB)).toBe(false);
  });
});

describe("isInMaintenanceAt — daysOfWeek filter", () => {
  it("suppresses only on listed weekdays", () => {
    // 2026-08-13 is Thursday (dow=4). 2026-08-16 is Sunday (dow=0).
    const sundayOnly: MaintenanceWindow = {
      start: "02:00",
      end: "04:00",
      daysOfWeek: [0],
    };
    expect(isInMaintenanceAt(wibTime(3, 0, 13), sundayOnly, WIB)).toBe(false);
    expect(isInMaintenanceAt(wibTime(3, 0, 16), sundayOnly, WIB)).toBe(true);
  });

  it("empty array is treated as every day", () => {
    const anyDay: MaintenanceWindow = { start: "10:00", end: "11:00", daysOfWeek: [] };
    expect(isInMaintenanceAt(wibTime(10, 30, 13), anyDay, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(10, 30, 16), anyDay, WIB)).toBe(true);
  });

  it("attributes an overnight window's tail to its start day", () => {
    // Fri night = dow=5. 22:00 Fri and 01:30 Sat both belong to the Friday
    // window "22:00-02:00 dow=[5]".
    // 2026-08-14 is Friday, 2026-08-15 is Saturday.
    const friNight: MaintenanceWindow = {
      start: "22:00",
      end: "02:00",
      daysOfWeek: [5],
    };
    expect(isInMaintenanceAt(wibTime(22, 30, 14), friNight, WIB)).toBe(true);
    expect(isInMaintenanceAt(wibTime(1, 30, 15), friNight, WIB)).toBe(true);
    // But 22:30 on Sat is NOT in a Fri-scoped window.
    expect(isInMaintenanceAt(wibTime(22, 30, 15), friNight, WIB)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Ad-hoc snooze storage
// -------------------------------------------------------------------------

describe("writeSnooze / readActiveSnoozes / clearSnooze", () => {
  it("stores and reads a global snooze that hasn't expired", () => {
    const sqlite = newDb();
    const now = 1_800_000_000;
    writeSnooze(sqlite, {
      scope: "global",
      startedAt: now,
      endsAt: now + 900,
      reason: "deploy",
    });
    const rows = readActiveSnoozes(sqlite, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe("global");
    expect(rows[0]!.reason).toBe("deploy");
    expect(rows[0]!.endsAt).toBe(now + 900);
  });

  it("filters out expired snoozes", () => {
    const sqlite = newDb();
    const now = 1_800_000_000;
    writeSnooze(sqlite, { scope: "global", startedAt: now, endsAt: now + 100 });
    expect(readActiveSnoozes(sqlite, now + 200)).toHaveLength(0);
  });

  it("keeps per-monitor and global snoozes independent", () => {
    const sqlite = newDb();
    const now = 1_800_000_000;
    writeSnooze(sqlite, {
      scope: { monitor: "site-a" },
      startedAt: now,
      endsAt: now + 60,
    });
    writeSnooze(sqlite, {
      scope: "global",
      startedAt: now,
      endsAt: now + 60,
    });
    expect(readActiveSnoozes(sqlite, now)).toHaveLength(2);
  });

  it("overwrites when the same scope is written twice", () => {
    const sqlite = newDb();
    const now = 1_800_000_000;
    writeSnooze(sqlite, { scope: "global", startedAt: now, endsAt: now + 60 });
    writeSnooze(sqlite, { scope: "global", startedAt: now, endsAt: now + 600 });
    const rows = readActiveSnoozes(sqlite, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endsAt).toBe(now + 600);
  });

  it("clearSnooze removes a specific scope", () => {
    const sqlite = newDb();
    const now = 1_800_000_000;
    writeSnooze(sqlite, {
      scope: { monitor: "site-a" },
      startedAt: now,
      endsAt: now + 60,
    });
    writeSnooze(sqlite, { scope: "global", startedAt: now, endsAt: now + 60 });
    clearSnooze(sqlite, "global");
    const rows = readActiveSnoozes(sqlite, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).not.toBe("global");
  });
});

// -------------------------------------------------------------------------
// Combined evaluation
// -------------------------------------------------------------------------

describe("isSnoozedNow", () => {
  const now = 1_800_000_000;

  it("global ad-hoc suppresses every monitor", () => {
    const snoozes: AdhocSnooze[] = [
      { scope: "global", startedAt: now, endsAt: now + 60, reason: "deploy" },
    ];
    const r = isSnoozedNow("any-monitor", now, snoozes, [], WIB);
    expect(r.suppressed).toBe(true);
    if (r.suppressed) expect(r.reason).toMatch(/adhoc-global/);
  });

  it("per-monitor ad-hoc suppresses only that monitor", () => {
    const snoozes: AdhocSnooze[] = [
      { scope: { monitor: "site-a" }, startedAt: now, endsAt: now + 60 },
    ];
    expect(isSnoozedNow("site-a", now, snoozes, [], WIB).suppressed).toBe(true);
    expect(isSnoozedNow("site-b", now, snoozes, [], WIB).suppressed).toBe(false);
  });

  it("recurring window suppresses when the wall clock matches", () => {
    const win: MaintenanceWindow[] = [{ start: "10:00", end: "12:00" }];
    const t = wibTime(11, 0);
    expect(isSnoozedNow("any", t, [], win, WIB).suppressed).toBe(true);
  });

  it("recurring window returns not suppressed outside the window", () => {
    const win: MaintenanceWindow[] = [{ start: "10:00", end: "12:00" }];
    const t = wibTime(13, 0);
    expect(isSnoozedNow("any", t, [], win, WIB).suppressed).toBe(false);
  });

  it("ad-hoc + recurring co-exist — either match is enough", () => {
    const snoozes: AdhocSnooze[] = [
      { scope: { monitor: "site-a" }, startedAt: now, endsAt: now + 60 },
    ];
    const win: MaintenanceWindow[] = [{ start: "10:00", end: "12:00" }];
    const outsideWindow = wibTime(13, 0);
    // Ad-hoc catches site-a, window is currently inactive:
    expect(isSnoozedNow("site-a", outsideWindow, snoozes, win, WIB).suppressed).toBe(true);
    // site-b: neither ad-hoc nor window matches:
    expect(isSnoozedNow("site-b", outsideWindow, snoozes, win, WIB).suppressed).toBe(false);
    // site-b: window is active:
    const insideWindow = wibTime(11, 0);
    expect(isSnoozedNow("site-b", insideWindow, snoozes, win, WIB).suppressed).toBe(true);
  });
});
