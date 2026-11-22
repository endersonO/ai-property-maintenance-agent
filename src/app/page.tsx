import Link from "next/link";
import { Suspense } from "react";
import { getSql } from "@/infra/db";
import { PostgresRepository } from "@/infra/postgres-repository";
import { toTicketSummaries } from "@/server/chat";
import { PortalChat } from "./portal-chat";

type TenantOption = { id: string; name: string; agency: string };

async function Portal({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const requested = (await searchParams).tenant;
  const sql = getSql();
  const tenants = await sql<TenantOption[]>`
    select t.id, t.name, a.name as agency
    from tenants t
    join properties p on p.id = t.property_id
    join agencies a on a.id = p.agency_id
    order by t.name
  `;
  const tenantId = tenants.find((t) => t.id === requested)?.id ?? tenants[0].id;

  const repo = new PostgresRepository(sql);
  const [context, tickets, reviews] = await Promise.all([
    repo.getTenantContext(tenantId),
    repo.listTickets(tenantId),
    repo.listReviews(tenantId),
  ]);

  return (
    <>
      {/* Simulated session: a real portal would take the tenant from authentication. */}
      <form method="get" className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="tenant" className="text-label text-muted">
            Signed in as (simulated)
          </label>
          <select
            id="tenant"
            name="tenant"
            defaultValue={tenantId}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 text-body"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {t.agency}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md border border-border-strong bg-surface px-3 py-2 text-body hover:bg-subtle"
        >
          Switch tenant
        </button>
      </form>
      <p className="mb-6 text-body-sm text-muted">
        {context?.property.address}, {context?.property.city} · managed by {context?.agency.name}
      </p>

      {/* Keyed by tenant: switching starts a fresh conversation. */}
      <PortalChat
        key={tenantId}
        tenantId={tenantId}
        tenantName={context?.tenant.name ?? ""}
        initialTickets={toTicketSummaries(tickets, reviews)}
      />
    </>
  );
}

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-12">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight">HomeFix</h1>
          <p className="text-body text-muted">AI-assisted maintenance · fictional data</p>
        </div>
        <Link href="/inspector" className="text-body text-accent underline-offset-2 hover:underline">
          Agent Inspector
        </Link>
      </header>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Portal searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
