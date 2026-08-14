import { Radar } from "lucide-react";
import { BrandMark } from "./brand-mark";
import { Section } from "./shared";

// Three sources, deliberately not three equal cards. Rows on a shared grid,
// each one hanging its source name and detail off a fixed logo column, with a
// single hairline between rows rather than a box around each.
const SOURCES = [
  {
    key: "cloudflare",
    name: "Cloudflare",
    detail:
      "Request volume, status codes, cache hit ratio and firewall events. One GraphQL query with four aliases per poll, not four round trips.",
  },
  {
    key: "ga4",
    name: "Google Analytics 4",
    detail:
      "Active users right now and page views in the last 30 minutes, read from the Realtime API. Optional: leave the property id out and the collector stays quiet.",
  },
  {
    key: "probe",
    name: "HTTP probe",
    detail:
      "Status code, latency, and a string that must appear in the body. That last check is what catches an origin serving an error page with a 200.",
  },
] as const;

export function Signals() {
  return (
    <Section id="signals" labelledBy="signals-heading" className="py-24 lg:py-32">
      <h2
        id="signals-heading"
        className="nw-reveal max-w-[16ch] text-3xl leading-[1.1] text-balance md:text-4xl"
      >
        Three sources, one verdict.
      </h2>

      <ul className="mt-12 list-none space-y-0 p-0">
        {SOURCES.map((s, i) => (
          <li
            key={s.key}
            className={
              "nw-reveal grid grid-cols-1 gap-x-8 gap-y-3 py-8 sm:grid-cols-12 " +
              (i > 0 ? "border-t border-border/60" : "")
            }
          >
            <div className="flex items-center gap-4 sm:col-span-4">
              <span className="text-muted-foreground" aria-hidden="true">
                {s.key === "probe" ? (
                  <Radar size={26} strokeWidth={1.5} />
                ) : (
                  <BrandMark
                    name={s.key === "cloudflare" ? "cloudflare" : "ga4"}
                    className="size-[26px]"
                    decorative
                  />
                )}
              </span>
              <h3 className="text-xl md:text-2xl">{s.name}</h3>
            </div>
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground sm:col-span-8">
              {s.detail}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
