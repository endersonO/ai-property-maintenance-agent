import * as seed from "@/infra/seed-data";
import type { BriefQuery, BriefReport, OperationsContext, OperationsPort, Report } from "./port";

// In-memory operations port for executor evals and tests: canned reports, filtered to the
// requested agencies, returned with their context, and the calls it received.
export class InMemoryOperations implements OperationsPort {
  readonly calls: { kind: "volume" | "resolution" | "openNow"; query: Pick<BriefQuery, "agencyIds"> & { period?: string; priority?: string | null } }[] = [];

  constructor(
    private readonly reports: { volume: Report; resolution: Report; openNow?: Report },
    private readonly ctx: OperationsContext = { dataset: "synthetic", asOf: new Date("2026-11-01T00:00:00Z") },
  ) {}

  async agencyNames(agencyIds: string[]) {
    return Object.fromEntries(seed.agencies.filter((a) => agencyIds.includes(a.id)).map((a) => [a.id, a.name]));
  }

  async agencies(agencyIds: string[]) {
    return seed.agencies
      .filter((a) => agencyIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.name, acquiredOn: a.acquiredOn, onboardedOn: a.onboardedOn }));
  }

  private filtered(report: Report, query: Pick<BriefQuery, "agencyIds">): BriefReport {
    return {
      facts: report.facts.filter((f) => f.agencyId === "all" || query.agencyIds.includes(f.agencyId)),
      notes: report.notes,
      ...this.ctx,
    };
  }

  async volume(query: BriefQuery) {
    this.calls.push({ kind: "volume", query });
    return this.filtered(this.reports.volume, query);
  }

  async resolution(query: BriefQuery & { priority: "emergency" | "high" | "normal" | "low" | null }) {
    this.calls.push({ kind: "resolution", query });
    return this.filtered(this.reports.resolution, query);
  }

  async openNow(query: Pick<BriefQuery, "agencyIds">) {
    this.calls.push({ kind: "openNow", query });
    const report = this.reports.openNow ?? { facts: [], notes: [] };
    return {
      facts: report.facts.filter((f) => f.agencyId === "all" || query.agencyIds.includes(f.agencyId)),
      notes: report.notes,
      dataset: "live" as const,
      asOf: new Date("2026-11-23T10:00:00Z"),
    };
  }
}
