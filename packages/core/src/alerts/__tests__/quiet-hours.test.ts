import { describe, expect, it } from "bun:test";
import { isQuietAt, parseQuietHours } from "../quiet-hours.ts";

const WIB = 7;

// A stable timestamp: 2026-08-13 05:00:00 WIB = 22:00 previous day UTC.
// UTC = 1786964400 - 7*3600 = wait let me compute properly.
// 2026-08-13 00:00:00 UTC = ?  Not critical — I'll build timestamps
// from a fixed WIB anchor.

function wibTime(hh: number, mm: number, day = 13): number {
  // Anchor day: 2026-08-13. WIB midnight = 2026-08-12 17:00 UTC.
  // Just build from a known Date.
  const utcMidnight = Date.UTC(2026, 7, day, -7, 0, 0); // month is 0-based
  return Math.floor(utcMidnight / 1000) + hh * 3600 + mm * 60;
}

describe("parseQuietHours", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parseQuietHours(null)).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours("")).toBeNull();
  });

  it("parses a normal window", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({
      startMinutes: 22 * 60,
      endMinutes: 7 * 60,
    });
  });

  it("parses a daytime window (start < end)", () => {
    expect(parseQuietHours("09:00-17:00")).toEqual({
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
    });
  });

  it("throws on malformed input", () => {
    expect(() => parseQuietHours("22-07")).toThrow(/invalid/);
    expect(() => parseQuietHours("bogus")).toThrow(/invalid/);
    expect(() => parseQuietHours("22:00 to 07:00")).toThrow(/invalid/);
  });

  it("returns null for zero-width window (start == end)", () => {
    expect(parseQuietHours("22:00-22:00")).toBeNull();
  });
});

describe("isQuietAt — daytime window (no midnight crossing)", () => {
  const w = parseQuietHours("09:00-17:00")!;

  it("returns true inside the window", () => {
    expect(isQuietAt(wibTime(10, 0), w, WIB)).toBe(true);
    expect(isQuietAt(wibTime(16, 59), w, WIB)).toBe(true);
  });

  it("returns false at boundary and outside", () => {
    expect(isQuietAt(wibTime(9, 0), w, WIB)).toBe(true); // start inclusive
    expect(isQuietAt(wibTime(17, 0), w, WIB)).toBe(false); // end exclusive
    expect(isQuietAt(wibTime(8, 59), w, WIB)).toBe(false);
    expect(isQuietAt(wibTime(23, 0), w, WIB)).toBe(false);
  });
});

describe("isQuietAt — overnight window (crosses midnight)", () => {
  const w = parseQuietHours("22:00-07:00")!;

  it("returns true in the late-night portion", () => {
    expect(isQuietAt(wibTime(22, 0), w, WIB)).toBe(true);
    expect(isQuietAt(wibTime(23, 30), w, WIB)).toBe(true);
  });

  it("returns true in the early-morning portion", () => {
    expect(isQuietAt(wibTime(6, 59), w, WIB)).toBe(true);
    expect(isQuietAt(wibTime(0, 0), w, WIB)).toBe(true);
  });

  it("returns false during the day", () => {
    expect(isQuietAt(wibTime(7, 0), w, WIB)).toBe(false); // end exclusive
    expect(isQuietAt(wibTime(9, 0), w, WIB)).toBe(false);
    expect(isQuietAt(wibTime(21, 59), w, WIB)).toBe(false);
  });
});
