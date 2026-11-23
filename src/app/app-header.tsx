import { Logo } from "./logo";
import { DemoHomeLink, DemoNav } from "./site-nav";

// Shared header: brand and demo navigation on one row, the page's title below.
export function AppHeader({
  title,
  subtitle,
  current,
  searchParams,
}: {
  title: string;
  subtitle?: string;
  current: "portal" | "operations" | "inspector";
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <header className="mb-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DemoHomeLink searchParams={searchParams}>
          <Logo />
        </DemoHomeLink>
        <DemoNav current={current} searchParams={searchParams} />
      </div>
      <div>
        <h1 className="text-title-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-body text-muted">{subtitle}</p>}
      </div>
    </header>
  );
}
