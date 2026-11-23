import { Suspense } from "react";
import type { Metadata } from "next";
import { AppHeader } from "./app-header";
import { getSql } from "@/infra/db";
import { PostgresRepository } from "@/infra/postgres-repository";
import { headers } from "next/headers";
import { clientKey } from "@/server/http";
import { checkAccess } from "@/server/access";
import { toTicketSummaries } from "@/server/chat";
import { AccessForm } from "./access-form";
import { PortalChat } from "./portal-chat";

type TenantOption = { id: string; name: string; agency: string };

async function Portal({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { tenant: requested, code } = await searchParams;
  const access = checkAccess(code, clientKey(await headers()));
  if (access !== "granted") return <AccessForm locked={access === "locked"} />;
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
        {typeof code === "string" && <input type="hidden" name="code" value={code} />}
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
        accessCode={typeof code === "string" ? code : null}
      />
    </>
  );
}

export const metadata: Metadata = {
  title: "Tenant portal",
  description: "Report a maintenance problem to your letting agency, or ask how a ticket is going.",
};

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-12">
      <AppHeader
        title="Tenant portal"
        subtitle="Report a problem or ask about a ticket · fictional data"
        current="portal"
        searchParams={searchParams}
      />
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Portal searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
