import {
  siCloudflare,
  siDocker,
  siGoogleanalytics,
  siSqlite,
  siWhatsapp,
} from "simple-icons";

// Real brand marks from Simple Icons (CC0), bundled rather than pulled from a
// CDN — same rule as the fonts. `title` is the accessible name; where the mark
// sits next to its own name in text we pass decorative and let the text speak.
const MARKS = {
  cloudflare: siCloudflare,
  ga4: siGoogleanalytics,
  whatsapp: siWhatsapp,
  docker: siDocker,
  sqlite: siSqlite,
} as const;

export type BrandName = keyof typeof MARKS;

export function BrandMark({
  name,
  className,
  decorative = false,
}: {
  name: BrandName;
  className?: string;
  decorative?: boolean;
}) {
  const icon = MARKS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : icon.title}
    >
      <path d={icon.path} />
    </svg>
  );
}
