import { describe, expect, it } from "bun:test"
import { evaluateContent, findForbidden } from "../content.ts"

const OPTS = { spikeZ: 3.5, minRelativeChange: 0.4, minSamples: 6 }

// A believable baseline: a page that hovers around 100 KB.
const STEADY = [100_000, 101_000, 99_500, 100_400, 99_800, 100_200, 100_900]

describe("findForbidden", () => {
  it("returns nothing when the blocklist is empty", () => {
    expect(findForbidden("<html>slot gacor</html>", [])).toEqual([])
  })

  it("matches case-insensitively", () => {
    expect(findForbidden("<a>SLOT GacOr</a>", ["slot gacor"])).toEqual([
      "slot gacor",
    ])
  })

  it("returns every matching term, in blocklist order", () => {
    const body = "<p>judi online dan slot</p>"
    expect(findForbidden(body, ["slot", "judi", "poker"])).toEqual([
      "slot",
      "judi",
    ])
  })

  it("ignores blank and whitespace-only entries", () => {
    expect(findForbidden("anything at all", ["", "   "])).toEqual([])
  })

  it("does not match a term that is absent", () => {
    expect(findForbidden("<h1>Berita hari ini</h1>", ["slot"])).toEqual([])
  })
})

describe("evaluateContent — forbidden terms", () => {
  it("is silent when nothing matched and size is normal", () => {
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 100_100, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings).toEqual([])
  })

  it("raises critical on any hit, regardless of how healthy everything else is", () => {
    const r = evaluateContent(
      { forbidHits: ["slot gacor"], bodyBytes: 100_100, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.kind).toBe("forbidden")
    expect(r.findings[0]!.severity).toBe("critical")
    expect(r.findings[0]!.message).toContain('"slot gacor"')
  })

  it("caps how many terms reach the message but keeps the true total", () => {
    const hits = ["a1", "b2", "c3", "d4", "e5", "f6", "g7"]
    const r = evaluateContent(
      { forbidHits: hits, bodyBytes: 100_100, bodyBytesBaseline: STEADY },
      OPTS,
    )
    const finding = r.findings[0]!
    expect(finding.message).toContain("(+2 more)")
    expect(finding.meta.totalHits).toBe(7)
    expect(finding.meta.terms).toHaveLength(5)
  })

  it("truncates an absurdly long term so the WhatsApp body stays readable", () => {
    const long = "x".repeat(200)
    const r = evaluateContent(
      { forbidHits: [long], bodyBytes: 100_100, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings[0]!.message.length).toBeLessThan(120)
    expect(r.findings[0]!.message).toContain("…")
  })
})

describe("evaluateContent — body size", () => {
  it("warns when the page collapses to near-empty", () => {
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 500, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.kind).toBe("size")
    expect(r.findings[0]!.severity).toBe("warning")
    expect(r.findings[0]!.message).toContain("smaller")
    expect(r.findings[0]!.meta.direction).toBe("smaller")
  })

  it("warns when the page balloons", () => {
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 900_000, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings[0]!.meta.direction).toBe("larger")
  })

  it("stays silent below minSamples, however extreme the reading", () => {
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 0, bodyBytesBaseline: [100_000, 100_500] },
      OPTS,
    )
    expect(r.findings).toEqual([])
  })

  it("stays silent with no baseline at all", () => {
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 0, bodyBytesBaseline: [] },
      OPTS,
    )
    expect(r.findings).toEqual([])
  })

  it("tolerates ordinary page-to-page variation", () => {
    // A news homepage genuinely swings a few percent between reads. Against
    // this very tight baseline that is z > 4, so the z-guard alone would fire
    // — only the relative-change gate keeps it quiet.
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 103_000, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings).toEqual([])
  })

  it("stays silent on a big z when the relative change is small", () => {
    // Explicitly pins the two-gate behaviour: 10% off a rock-steady baseline
    // is statistically extreme but is not a broken page.
    const r = evaluateContent(
      { forbidHits: [], bodyBytes: 110_000, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings).toEqual([])
  })

  it("reports both findings independently when both fire", () => {
    const r = evaluateContent(
      { forbidHits: ["slot"], bodyBytes: 400, bodyBytesBaseline: STEADY },
      OPTS,
    )
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["forbidden", "size"])
  })
})
