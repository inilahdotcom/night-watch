interface LoaderProps {
  label?: string;
  hint?: string;
  className?: string;
}

export function Loader({ label = "Loading", hint, className }: LoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-4 py-16 ${className ?? ""}`}
    >
      <span aria-hidden className="pulse-dot" data-severity="ok" />
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      {hint && <div className="text-sm text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function InlineLoader({ label = "loading" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="mono inline-flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground"
    >
      <span aria-hidden className="pulse-dot" data-severity="ok" style={{ width: 8, height: 8 }} />
      {label}
    </span>
  );
}
