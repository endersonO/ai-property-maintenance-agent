import { Suspense } from "react";
import { connection } from "next/server";
import { getSql } from "@/infra/db";

type TenantRow = { id: string; name: string; agency: string; address: string; city: string };

async function Tenants() {
  await connection();
  const tenants = await getSql()<TenantRow[]>`
    select t.id, t.name, a.name as agency, p.address, p.city
    from tenants t
    join properties p on p.id = t.property_id
    join agencies a on a.id = p.agency_id
    order by t.name
  `;

  return (
    <ul className="space-y-2">
      {tenants.map((t) => (
        <li key={t.id} className="rounded border border-neutral-300 p-3 dark:border-neutral-700">
          <p className="font-medium">{t.name}</p>
          <p className="text-sm opacity-70">
            {t.address}, {t.city} · {t.agency}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold">HomeFix</h1>
      <p className="mb-6 opacity-70">AI-assisted maintenance for UK lettings</p>
      <Suspense fallback={<p>Loading tenants…</p>}>
        <Tenants />
      </Suspense>
    </main>
  );
}
