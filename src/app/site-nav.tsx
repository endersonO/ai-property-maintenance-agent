import Link from "next/link";
import { Suspense } from "react";

// Demo navigation between the personas: the tenant's portal, the operations manager's view and
// the platform team's Inspector.
// In a real product these would be separate apps with separate authentication.

const LINKS = [
  { id: "portal", href: "/", label: "Tenant portal" },
  { id: "operations", href: "/operations", label: "Operations" },
  { id: "inspector", href: "/inspector", label: "Agent Inspector" },
] as const;

export function SiteNav({ current, code }: { current: (typeof LINKS)[number]["id"]; code?: string | string[] }) {
  const suffix = typeof code === "string" && code ? `?code=${encodeURIComponent(code)}` : "";
  return (
    <nav aria-label="Demo views" className="flex rounded-md border border-border-strong p-0.5 text-body">
      {LINKS.map((link) => (
        <Link
          key={link.id}
          href={`${link.href}${suffix}`}
          aria-current={current === link.id ? "page" : undefined}
          className="rounded px-3 py-1 hover:bg-subtle aria-[current=page]:bg-accent aria-[current=page]:text-accent-text"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

// The access code lives in the (request-time) query string: render the nav with it inside a
// Suspense boundary, and without it as the static fallback.
async function NavWithCode({
  current,
  searchParams,
}: {
  current: (typeof LINKS)[number]["id"];
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await searchParams;
  return <SiteNav current={current} code={code} />;
}

export function DemoNav(props: {
  current: (typeof LINKS)[number]["id"];
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<SiteNav current={props.current} />}>
      <NavWithCode {...props} />
    </Suspense>
  );
}
