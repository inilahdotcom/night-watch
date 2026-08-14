import { createFileRoute } from "@tanstack/react-router";

import { MarketingNav } from "../components/marketing/nav";
import { Hero } from "../components/marketing/hero";
import { Premise } from "../components/marketing/premise";
import { Gates } from "../components/marketing/gates";
import { Signals } from "../components/marketing/signals";
import { Alerting } from "../components/marketing/alerting";
import { Deploy } from "../components/marketing/deploy";
import { MarketingFooter } from "../components/marketing/footer";
import { Rule } from "../components/marketing/shared";

// Public marketing page. Deliberately a sibling of "/" rather than a
// replacement: the dashboard's route, and the port 3011 URL in the README and
// the Docker docs, stay exactly where they were.
//
// Section order, each a distinct layout family so no two read alike:
//   hero (split, asset bleeding right)
//   premise (full-width statement, two columns of body)
//   gates (asymmetric five-cell grid)
//   signals (hairline rows on a shared grid)
//   alerting (text beside a phone-shaped asset; the only such split)
//   deploy (terminal panel beside a definition list)
export const Route = createFileRoute("/landing")({
  component: LandingPage,
  head: () => ({
    meta: [
      { title: "Night Watch: self-hosted monitoring that earns the 3am buzz" },
      {
        name: "description",
        content:
          "Self-hosted uptime, traffic anomaly, and Cloudflare firewall monitoring. Seasonal baselines and four guards keep false alarms off your phone. Two processes, one SQLite file.",
      },
      { property: "og:title", content: "Night Watch" },
      {
        property: "og:description",
        content:
          "Self-hosted monitoring that knows 3am is supposed to be quiet.",
      },
      { property: "og:image", content: "/marketing/dashboard-hero.webp" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function LandingPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <Hero />
        <Rule />
        <Premise />
        <Rule />
        <Gates />
        <Rule />
        <Signals />
        <Rule />
        <Alerting />
        <Rule />
        <Deploy />
      </main>
      <MarketingFooter />
    </>
  );
}
