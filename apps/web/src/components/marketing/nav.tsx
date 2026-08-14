import { GITHUB_URL } from "./shared";

// Single line at every breakpoint, 64px tall. Below `md` the three anchors
// drop and only the wordmark plus the source link remain: three in-page
// anchors do not earn a hamburger.
const LINKS = [
  { href: "#decides", label: "How it decides" },
  { href: "#signals", label: "Signals" },
  { href: "#deploy", label: "Deploy" },
];

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-6 px-5 sm:px-8"
      >
        <a
          href="#top"
          className="mono text-[11px] tracking-[0.22em] text-foreground uppercase no-underline hover:no-underline"
        >
          Night Watch
        </a>

        <ul className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="text-sm text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <a
          href={GITHUB_URL}
          className="text-sm text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline"
        >
          GitHub
        </a>
      </nav>
    </header>
  );
}
