import { describe, expect, it } from "bun:test";
import {
  dailyShape,
  gaussian,
  localHourAndDow,
  meanValueAt,
  mulberry32,
  weeklyShape,
} from "../patterns.ts";

describe("mulberry32", () => {
  it("is reproducible for a given seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 100; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const drawsA: number[] = [];
    const drawsB: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      drawsA.push(a());
      drawsB.push(b());
    }
    expect(drawsA).not.toEqual(drawsB);
  });

  it("stays in [0, 1)", () => {
    const r = mulberry32(999);
    for (let i = 0; i < 10_000; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("gaussian", () => {
  it("approximates mean=0, stddev=1 over many draws", () => {
    const r = mulberry32(7);
    let sum = 0;
    let sumSq = 0;
    const n = 5_000;
    for (let i = 0; i < n; i += 1) {
      const x = gaussian(r);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.06);
    expect(Math.abs(variance - 1)).toBeLessThan(0.1);
  });

  it("shifts by mean and scales by stddev", () => {
    const r = mulberry32(3);
    let sum = 0;
    const n = 5_000;
    for (let i = 0; i < n; i += 1) sum += gaussian(r, 100, 5);
    expect(Math.abs(sum / n - 100)).toBeLessThan(0.5);
  });
});

describe("dailyShape", () => {
  it("peaks in the workday (near hour 13)", () => {
    const peak = dailyShape(13);
    expect(peak).toBeGreaterThan(dailyShape(3));
    expect(peak).toBeGreaterThan(dailyShape(23));
  });

  it("has a secondary evening bump near hour 20", () => {
    // Evening should be higher than the pre-dawn trough.
    expect(dailyShape(20)).toBeGreaterThan(dailyShape(4));
  });

  it("has its trough in the pre-dawn hours (3am ish)", () => {
    const trough = dailyShape(3);
    for (const h of [1, 2, 3, 4, 5]) {
      expect(dailyShape(h)).toBeLessThan(dailyShape(13));
    }
    expect(trough).toBeGreaterThan(0);
  });

  it("stays within reasonable multiplicative bounds [0.1, 1.1]", () => {
    for (let h = 0; h < 24; h += 1) {
      const v = dailyShape(h);
      expect(v).toBeGreaterThan(0.1);
      expect(v).toBeLessThan(1.1);
    }
  });
});

describe("weeklyShape", () => {
  it("returns 0.65 on Sat and Sun", () => {
    expect(weeklyShape(0)).toBeCloseTo(0.65);
    expect(weeklyShape(6)).toBeCloseTo(0.65);
  });

  it("returns 1.0 on weekdays", () => {
    for (const dow of [1, 2, 3, 4, 5]) {
      expect(weeklyShape(dow)).toBe(1.0);
    }
  });
});

describe("localHourAndDow", () => {
  // Fixed anchor: 2026-01-01 00:00:00 UTC = 1767225600. Thu.
  const NEW_YEAR_UTC = 1767225600;

  it("shifts hour by offset", () => {
    // 00:00 UTC + 7h offset = 07:00 WIB
    expect(localHourAndDow(NEW_YEAR_UTC, 7).hour).toBe(7);
  });

  it("wraps hour across midnight", () => {
    // 20:00 UTC + 7h = 03:00 next day
    const twentyUtc = NEW_YEAR_UTC + 20 * 3600;
    const r = localHourAndDow(twentyUtc, 7);
    expect(r.hour).toBe(3);
  });

  it("returns Sun=0 .. Sat=6", () => {
    // 2026-01-01 is a Thursday → dow=4 (Sun=0 convention)
    expect(localHourAndDow(NEW_YEAR_UTC, 0).dow).toBe(4);
  });

  it("advances dow after WIB midnight", () => {
    // 17:00 UTC Thu + 7h = 00:00 WIB Fri → dow=5
    const seventeenUtc = NEW_YEAR_UTC + 17 * 3600;
    expect(localHourAndDow(seventeenUtc, 7).dow).toBe(5);
  });
});

describe("meanValueAt — combined shaping", () => {
  const NEW_YEAR_UTC = 1767225600; // Thu 00:00 UTC = Thu 07:00 WIB
  const PEAK = 1000;

  it("returns a smaller value during weekend hours than the equivalent weekday hour", () => {
    // 2026-01-01 (Thu) 13:00 WIB → 06:00 UTC
    const weekdayNoon = NEW_YEAR_UTC + 6 * 3600;
    // 2026-01-03 (Sat) 13:00 WIB → same shifted by 2 days
    const saturdayNoon = weekdayNoon + 2 * 24 * 3600;
    const weekday = meanValueAt(weekdayNoon, PEAK, 7);
    const weekend = meanValueAt(saturdayNoon, PEAK, 7);
    expect(weekend).toBeLessThan(weekday);
    expect(weekend / weekday).toBeCloseTo(0.65, 1);
  });

  it("returns a smaller value at 03:00 WIB than at 13:00 WIB", () => {
    const dayHour = NEW_YEAR_UTC + 6 * 3600; // 13:00 WIB Thu
    const nightHour = NEW_YEAR_UTC + 20 * 3600; // 03:00 WIB Fri
    expect(meanValueAt(nightHour, PEAK, 7)).toBeLessThan(
      meanValueAt(dayHour, PEAK, 7),
    );
  });
});
