import { GITHUB_URL, PILL_PRIMARY, PILL_SECONDARY } from "./shared";

// Four text elements at most, and this uses three: headline, subtext, CTAs.
// No eyebrow, no tagline under the buttons, no trust strip. The asset is a
// real screenshot of the dashboard, cropped so it runs off the right edge.
export function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-heading"
      className="relative overflow-hidden"
    >
      {/* items-start, not items-center: with a tall asset alongside, centring
          drops the headline to the middle of the viewport and reads as a bug. */}
      <div className="mx-auto grid w-full max-w-[1180px] grid-cols-1 items-start gap-14 px-5 pt-16 pb-20 sm:px-8 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-12 lg:gap-10 lg:pt-24 lg:pb-24">
        <div className="lg:col-span-7">
          <h1
            id="hero-heading"
            className="nw-enter max-w-[27ch] text-4xl leading-[1.04] text-balance md:text-5xl lg:text-[3rem]"
            style={{ "--nw-i": 0 } as React.CSSProperties}
          >
            Monitoring that knows 3am is supposed to be quiet.
          </h1>

          <p
            className="nw-enter mt-6 max-w-[52ch] text-base leading-relaxed text-muted-foreground md:text-lg"
            style={{ "--nw-i": 1 } as React.CSSProperties}
          >
            Self-hosted uptime, traffic anomaly, and Cloudflare firewall
            monitoring. Two processes, one SQLite file, one Docker command.
          </p>

          <div
            className="nw-enter mt-9 flex flex-wrap items-center gap-3"
            style={{ "--nw-i": 2 } as React.CSSProperties}
          >
            <a href="#deploy" className={PILL_PRIMARY}>
              Quick start
            </a>
            <a href={GITHUB_URL} className={PILL_SECONDARY}>
              GitHub
            </a>
          </div>
        </div>

        {/* Runs past the right edge on desktop for an off-centre composition;
            squares up to a contained, full-width figure under `lg`. */}
        <div className="lg:col-span-5">
          <figure
            className="nw-enter m-0 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)] lg:w-[168%] lg:max-w-none"
            style={{ "--nw-i": 3 } as React.CSSProperties}
          >
            <img
              src="/marketing/dashboard-hero.webp"
              width={1600}
              height={1394}
              fetchPriority="high"
              loading="eager"
              decoding="async"
              alt="The Night Watch dashboard reading Attention needed now, with one critical uptime alert and one slow-response warning above a grid of four monitors and their request history."
              className="block h-auto w-full"
            />
          </figure>
        </div>
      </div>
    </section>
  );
}
