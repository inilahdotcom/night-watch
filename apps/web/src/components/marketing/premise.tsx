import { Section } from "./shared";

// Full-width statement. This is the one section on the page whose job is the
// argument itself, so it gets the largest type and no competing element.
export function Premise() {
  return (
    <Section labelledBy="premise-heading" className="py-24 lg:py-32">
      <h2
        id="premise-heading"
        className="nw-reveal max-w-[19ch] text-3xl leading-[1.08] text-balance md:text-4xl lg:text-[2.75rem]"
      >
        The hard part is not noticing. It is not crying wolf.
      </h2>

      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-12">
        <p className="nw-reveal max-w-[58ch] text-base leading-relaxed text-muted-foreground">
          A fixed threshold fires every night at 03:00, because 03:00 is
          legitimately quiet. Tune it until it stops, and it stops catching
          real incidents too.
        </p>
        <p className="nw-reveal max-w-[58ch] text-base leading-relaxed text-muted-foreground">
          Night Watch compares this Tuesday at 14:00 against the same bucket on
          the last four Tuesdays. Then it makes the deviation survive four more
          checks before anything reaches you.
        </p>
      </div>
    </Section>
  );
}
