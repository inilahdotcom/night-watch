import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { LineChart } from "../line-chart"

const s = (values: Array<number | null>) => [
  { label: "Bots", color: "var(--status-warning)", values },
]

describe("LineChart", () => {
  it("draws one polyline for a contiguous series", () => {
    const html = renderToStaticMarkup(
      <LineChart bucketCount={4} series={s([1, 5, 3, 9])} windowHours={24} unit="bot traffic" />,
    )
    expect((html.match(/<polyline/g) ?? []).length).toBe(1)
    expect(html).toContain('vector-effect="non-scaling-stroke"')
  })

  it("breaks the line at a gap instead of drawing through it", () => {
    const html = renderToStaticMarkup(
      <LineChart bucketCount={5} series={s([1, 5, null, 3, 9])} windowHours={24} unit="bot traffic" />,
    )
    expect((html.match(/<polyline/g) ?? []).length).toBe(2)
  })

  it("renders a lone bucket between gaps as a dot", () => {
    const html = renderToStaticMarkup(
      <LineChart bucketCount={5} series={s([1, 2, null, 7, null])} windowHours={24} unit="bot traffic" />,
    )
    expect((html.match(/<circle/g) ?? []).length).toBe(1)
  })

  it("shows an empty state rather than an empty chart", () => {
    const html = renderToStaticMarkup(
      <LineChart bucketCount={3} series={s([null, null, null])} windowHours={24} unit="bot traffic" />,
    )
    expect(html).toContain("No bot traffic recorded")
    expect(html).not.toContain("<svg")
  })

  it("survives a single bucket without dividing by zero", () => {
    const html = renderToStaticMarkup(
      <LineChart bucketCount={1} series={s([42])} windowHours={24} unit="bot traffic" />,
    )
    expect(html).not.toContain("NaN")
    expect(html).toContain("<circle")
  })
})
