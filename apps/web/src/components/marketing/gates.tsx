import { Section } from "./shared";

// Five things must hold before an alert is sent, so the grid has exactly five
// cells: one wide feature plus a 5-column partner, then a row of three.
// Two cells carry a tinted surface so this does not read as five identical
// text boxes on the same canvas.
export function Gates() {
  return (
    <Section id="decides" labelledBy="gates-heading" className="py-24 lg:py-32">
      <h2
        id="gates-heading"
        className="nw-reveal max-w-[20ch] text-3xl leading-[1.1] text-balance md:text-4xl"
      >
        What has to be true before your phone buzzes.
      </h2>

      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-12">
        {/* Feature cell: the three simultaneous guards, as real numbers. */}
        <article className="nw-reveal relative overflow-hidden rounded-2xl border border-border bg-card p-7 md:col-span-7 md:p-9">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_85%_0%,rgba(0,153,255,0.16),transparent_58%)]"
          />
          <div className="relative">
            <h3 className="text-xl md:text-2xl">All three guards, or nothing</h3>
            <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
              A z-score on its own is not evidence. All three minimums have to
              clear at once, and any one of them failing blocks the alert
              outright.
            </p>
            {/* Single-word labels: anything longer wraps in a third of a phone
                screen and knocks the figures out of alignment. */}
            <dl className="mt-8 grid grid-cols-3 gap-4">
              {[
                { v: "3.5", k: "z-score" },
                { v: "50", k: "baseline" },
                { v: "40%", k: "swing" },
              ].map((g) => (
                // Reversed column so the figure reads first while the term
                // still precedes its description in the DOM.
                <div key={g.k} className="flex flex-col-reverse justify-end gap-2">
                  <dt className="mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    {g.k}
                  </dt>
                  <dd className="mono m-0 text-3xl leading-none text-foreground md:text-4xl">
                    {g.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </article>

        <article className="nw-reveal rounded-2xl border border-border bg-card p-7 md:col-span-5 md:p-9">
          <h3 className="text-xl md:text-2xl">A baseline with a calendar</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Every 5-minute bucket is measured against the same time of day one
            to four weeks back. On a fresh install, before that history exists,
            it falls back to a 3-hour rolling window: noisier, but useful on
            day one.
          </p>
        </article>

        {/* Lower row is 5 / 3 / 4, not three equal thirds: each cell is sized
            to the copy it actually carries. */}
        <article className="nw-reveal relative overflow-hidden rounded-2xl border border-border bg-secondary p-7 md:col-span-5 md:p-9">
          <h3 className="text-xl md:text-2xl">Outliers do not move the line</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Median and MAD instead of mean and standard deviation. If last week
            had an incident, a mean-based baseline quietly stretches, and this
            week's incident slips through.
          </p>
        </article>

        <article className="nw-reveal rounded-2xl border border-border bg-card p-7 md:col-span-3 md:p-9">
          <h3 className="text-xl md:text-2xl">Twice in a row</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            A single bucket that ripples and clears is not worth a
            notification. The anomaly has to repeat before it becomes an alert.
          </p>
        </article>

        <article className="nw-reveal rounded-2xl border border-border bg-card p-7 md:col-span-4 md:p-9">
          <h3 className="text-xl md:text-2xl">Their outage, not your Wi-Fi</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            When a probe fails, the worker checks a control URL first. If that
            is unreachable too, the monitor host is the one offline, and
            nothing fires.
          </p>
        </article>
      </div>
    </Section>
  );
}
