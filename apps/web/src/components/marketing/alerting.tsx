import { BellRing, MoonStar } from "lucide-react";
import { BrandMark } from "./brand-mark";
import { Section } from "./shared";

const CHANNELS = [
  {
    icon: <BellRing size={20} strokeWidth={1.5} />,
    title: "Browser push",
    body: "Web push over VAPID, silent by default. It reaches the machine you are already sitting at without making noise.",
  },
  {
    icon: <BrandMark name="whatsapp" className="size-5" decorative />,
    title: "WhatsApp group",
    body: "The official Cloud API cannot post to groups, so the worker speaks the WhatsApp Web protocol directly. Scan a QR once.",
  },
  {
    icon: <MoonStar size={20} strokeWidth={1.5} />,
    title: "Quiet hours",
    body: "Non-critical alerts stay muted overnight. A site that is actually down still breaks through, and recoveries go to whoever got the original.",
  },
];

// The only text-beside-image split on the page, so the zigzag never starts.
export function Alerting() {
  return (
    <Section labelledBy="alerting-heading" className="py-24 lg:py-32">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-7">
          <h2
            id="alerting-heading"
            className="nw-reveal max-w-[18ch] text-3xl leading-[1.1] text-balance md:text-4xl"
          >
            The alert lands where you already look.
          </h2>

          <dl className="mt-10 space-y-8">
            {CHANNELS.map((c) => (
              <div key={c.title} className="nw-reveal flex gap-4">
                <span
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  {c.icon}
                </span>
                <div>
                  <dt className="text-base text-foreground">{c.title}</dt>
                  <dd className="mt-1.5 m-0 max-w-[54ch] text-sm leading-relaxed text-muted-foreground">
                    {c.body}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <div className="lg:col-span-5">
          <figure className="nw-reveal-asset m-0 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_40px_120px_-50px_rgba(0,0,0,0.9)]">
            <img
              src="/marketing/dashboard-mobile.webp"
              width={1000}
              height={1860}
              loading="lazy"
              decoding="async"
              alt="The dashboard on a phone, showing the same critical and warning alerts stacked in a single column."
              className="block h-auto w-full"
            />
          </figure>
        </div>
      </div>
    </Section>
  );
}
