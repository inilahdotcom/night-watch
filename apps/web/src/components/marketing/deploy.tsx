import { BrandMark } from "./brand-mark";
import { GITHUB_URL, PILL_PRIMARY, Section } from "./shared";

const COMMANDS = [
  "cp config/monitors.example.json config/monitors.json",
  "cp .env.example .env",
  "docker compose up -d --build",
];

// Real figures: `bun run test` reports 234 passing in 725ms at the time of
// writing, and the datastore really is a single file.
const FACTS = [
  { v: "234", k: "unit tests" },
  { v: "725ms", k: "to run them" },
  { v: "1", k: "SQLite file" },
];

export function Deploy() {
  return (
    <Section id="deploy" labelledBy="deploy-heading" className="py-24 lg:py-32">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <h2
            id="deploy-heading"
            className="nw-reveal text-3xl leading-[1.1] text-balance md:text-4xl"
          >
            Up in three lines.
          </h2>
          <p className="nw-reveal mt-5 max-w-[46ch] text-base leading-relaxed text-muted-foreground">
            Copy the two example files, edit the URL you want watched, then
            bring up three containers: the
            migration runs once and exits, the dashboard serves on port 3011,
            and the worker collects, analyses, and alerts.
          </p>

          {/* Hairlines rather than three more boxes: the page already has
              enough card surfaces by this point. */}
          <dl className="nw-reveal mt-10 divide-y divide-border/60 border-y border-border/60">
            {FACTS.map((f) => (
              <div
                key={f.k}
                className="flex items-baseline justify-between gap-6 py-3.5"
              >
                <dt className="text-sm text-muted-foreground">{f.k}</dt>
                <dd className="mono m-0 text-lg text-foreground">{f.v}</dd>
              </div>
            ))}
          </dl>

          <div className="nw-reveal mt-9">
            <a href={GITHUB_URL} className={PILL_PRIMARY}>
              GitHub
            </a>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="nw-reveal-asset overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center gap-2.5 border-b border-border/70 px-5 py-3.5">
              <BrandMark
                name="docker"
                className="size-4 text-muted-foreground"
                decorative
              />
              <span className="mono text-xs text-muted-foreground">
                docker compose
              </span>
            </div>
            <pre className="mono overflow-x-auto px-5 py-6 text-[13px] leading-[2.1] text-foreground">
              <code>
                {COMMANDS.map((c) => (
                  <span key={c} className="block whitespace-pre">
                    <span className="text-muted-foreground select-none">$ </span>
                    {c}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </Section>
  );
}
