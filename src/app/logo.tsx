// The HomeFix mark: a home with a check — maintenance handled. Same drawing as app/icon.svg.
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path d="M7.5 15.5 16 8.5l8.5 7" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="stroke-accent-text" />
      <path d="M10 14v9.5h12V14" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="stroke-accent-text" />
      <path d="m13 18.8 2.2 2.2 3.8-4.2" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="stroke-accent-soft" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-heading font-semibold tracking-tight">HomeFix</span>
    </span>
  );
}
