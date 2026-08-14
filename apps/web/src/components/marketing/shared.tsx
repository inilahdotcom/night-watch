import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const GITHUB_URL = "https://github.com/inilahdotcom/night-watch";

// Shape system for this page, applied everywhere:
//   interactive  -> full pill      (matches the dashboard's snooze buttons)
//   surfaces     -> rounded-2xl    (matches the dashboard's cards)
export const PILL =
  "inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-medium " +
  "whitespace-nowrap transition-[background-color,transform,border-color] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] " +
  "active:translate-y-px";

// #fff on #000: 21:1. Well past AA.
export const PILL_PRIMARY = cn(
  PILL,
  "bg-primary text-primary-foreground hover:bg-white/88",
);

// #fff on #090909 with a visible hairline: passes AA, and the border keeps the
// control legible without relying on the fill.
export const PILL_SECONDARY = cn(
  PILL,
  "border border-border text-foreground hover:border-white/28 hover:bg-secondary",
);

export function Section({
  id,
  className,
  children,
  labelledBy,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("mx-auto w-full max-w-[1180px] px-5 sm:px-8", className)}
    >
      {children}
    </section>
  );
}

export function Rule() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 sm:px-8">
      <div className="nw-rule" />
    </div>
  );
}
