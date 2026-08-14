import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";

import appCss from "../styles.css?url";

// Inlined into <head> so the very first paint is our dark canvas + a pulsing
// preloader — never a flash of unstyled content while the hashed CSS bundle
// is still on the wire. Kept intentionally self-contained (no Tailwind, no
// custom properties) so it works before the main stylesheet arrives.
const PRELOADER_CSS = `
  html { background: #090909; color-scheme: dark; }
  body { margin: 0; background: #090909; color: #fff; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  html:not(.nw-css-ready) body > *:not(#nw-preloader) { visibility: hidden; }
  #nw-preloader {
    position: fixed; inset: 0; z-index: 9999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px; background: #090909;
    transition: opacity 220ms ease, visibility 220ms ease;
  }
  html.nw-css-ready #nw-preloader { opacity: 0; visibility: hidden; pointer-events: none; }
  .nw-preloader__dot {
    width: 12px; height: 12px; border-radius: 9999px;
    background: #22c55e; box-shadow: 0 0 24px -4px #22c55e;
    animation: nw-preloader-pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  .nw-preloader__label {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: #666;
  }
  @keyframes nw-preloader-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.7); }
  }
  @media (prefers-reduced-motion: reduce) { .nw-preloader__dot { animation: none; } }
`;

// Marks <html> as css-ready once the app stylesheet resolves so the preloader
// fades out. Safety timeout guarantees the user is never stuck behind the
// overlay if the stylesheet fails.
const PRELOADER_READY_SCRIPT = `
  (function () {
    var reveal = function () { document.documentElement.classList.add('nw-css-ready'); };
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    if (!links.length) { reveal(); return; }
    var remaining = links.length;
    var done = function () { if (--remaining <= 0) reveal(); };
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var loaded = false;
      try { loaded = !!(link.sheet && link.sheet.cssRules); } catch (e) {}
      if (loaded) { done(); continue; }
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
    }
    setTimeout(reveal, 3000);
  })();
`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#090909" },
      {
        name: "description",
        content:
          "Night Watch — self-hosted monitoring for websites: uptime, traffic anomalies, DDoS patterns. Push + WhatsApp alerts.",
      },
      { title: "Night Watch" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "icon", href: "/favicon.ico" },
      { rel: "apple-touch-icon", href: "/favicon.ico" },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto max-w-md p-6 pt-24">
      <h1 className="text-3xl">404</h1>
      <p className="text-muted-foreground mt-2">This page is not on the watch.</p>
    </main>
  ),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: PRELOADER_CSS }} />
      </head>
      <body>
        <div id="nw-preloader" aria-hidden="true">
          <span className="nw-preloader__dot" />
          <span className="nw-preloader__label">Night Watch</span>
        </div>
        {children}
        <script dangerouslySetInnerHTML={{ __html: PRELOADER_READY_SCRIPT }} />
        {import.meta.env.DEV && (
          <TanStackDevtools
            config={{ position: "bottom-right" }}
            plugins={[
              { name: "Tanstack Router", render: <TanStackRouterDevtoolsPanel /> },
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  );
}
