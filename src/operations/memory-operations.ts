import * as seed from "@/infra/seed-data";
import type { BriefQuery, BriefReport, OperationsContext, OperationsPort, Report } from "./port";

// In-memory operations port for executor evals and tests: canned reports, filtered to the
// requested agencies, returned with their context, and the calls it received.
export class InMemoryOperations implements OperationsPort {
  readonly calls: { kind: "volume" | "resolution"; query: BriefQuery & { priority?: string | null } }[] = [];

  constructor(
    private readonly reports: { volume: Report; resolution: Report },
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

  private filtered(report: Report, query: BriefQuery): BriefReport {
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
}
