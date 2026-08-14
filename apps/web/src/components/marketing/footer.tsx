import { GITHUB_URL } from "./shared";

const LINKS = [
  { href: GITHUB_URL, label: "GitHub" },
  { href: `${GITHUB_URL}#readme`, label: "Documentation" },
  { href: `${GITHUB_URL}#environment-reference`, label: "Environment reference" },
  { href: "/", label: "Dashboard" },
];

export function MarketingFooter() {
  return (
    <footer className="mt-8 border-t border-border/70">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 px-5 py-12 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="mono text-[11px] tracking-[0.22em] text-foreground uppercase">
            Night Watch
          </p>
          <p className="mt-2 max-w-[46ch] text-sm text-muted-foreground">
            Self-hosted monitoring. Your data stays on your machine.
          </p>
        </div>

        <nav aria-label="Footer">
          <ul className="flex list-none flex-wrap items-center gap-x-7 gap-y-3 p-0">
            {LINKS.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  className="text-sm text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
