import { describe, expect, it } from "bun:test"
import { evaluateCert } from "../cert.ts"

const OPTS = { certWarnDays: 14, certCritDays: 3 }

describe("evaluateCert", () => {
  it("stays silent well before expiry", () => {
    expect(evaluateCert(90, OPTS).severity).toBeNull()
    expect(evaluateCert(15, OPTS).severity).toBeNull()
  })

  it("warns from the warn threshold inclusive", () => {
    expect(evaluateCert(14, OPTS).severity).toBe("warning")
    expect(evaluateCert(4, OPTS).severity).toBe("warning")
  })

  it("escalates from the critical threshold inclusive", () => {
    expect(evaluateCert(3, OPTS).severity).toBe("critical")
    expect(evaluateCert(1, OPTS).severity).toBe("critical")
  })

  it("treats expiry day itself as critical", () => {
    const r = evaluateCert(0, OPTS)
    expect(r.severity).toBe("critical")
    expect(r.message).toBe("certificate expires today")
  })

  it("reports an already-expired certificate as critical no matter the tuning", () => {
    // Even with thresholds that would silence everything else.
    const lax = { certWarnDays: 0, certCritDays: 0 }
    const r = evaluateCert(-5, lax)
    expect(r.severity).toBe("critical")
    expect(r.message).toBe("certificate expired 5 days ago")
  })

  it("gets the singular/plural right on both sides of zero", () => {
    expect(evaluateCert(1, OPTS).message).toBe("certificate expires in 1 day")
    expect(evaluateCert(2, OPTS).message).toBe("certificate expires in 2 days")
    expect(evaluateCert(-1, OPTS).message).toBe("certificate expired 1 day ago")
  })

  it("honours thresholds that are configured wider than the defaults", () => {
    const wide = { certWarnDays: 60, certCritDays: 30 }
    expect(evaluateCert(45, wide).severity).toBe("warning")
    expect(evaluateCert(20, wide).severity).toBe("critical")
    expect(evaluateCert(90, wide).severity).toBeNull()
  })
})
