import { describe, expect, it } from "vitest";
import { repositoryContract } from "@/domain/repository.contract";
import { InMemoryRepository } from "./memory-repository";

repositoryContract("InMemoryRepository", async () => ({
  repo: new InMemoryRepository(),
  runId: "run-test",
}));

describe("InMemoryRepository faults", () => {
  it("a failing review insert leaves no ticket behind", async () => {
    const repo = new InMemoryRepository();
    repo.injectFault("review_insert");
    await expect(
      repo.createTicketWithReview(
        {
          agencyId: "agency_northbridge",
          propertyId: "prop_mcr_1",
          tenantId: "tenant_olivia",
          runId: "run-test",
          category: "plumbing",
          hazards: ["active_water_leak"],
          location: null,
          description: "Leak",
          priority: "emergency",
          estimatedCostGbp: 180,
          policyVersion: 1,
          idempotencyKey: "key-1",
        },
        {
          runId: "run-test",
          agencyId: "agency_northbridge",
          tenantId: "tenant_olivia",
          source: "policy",
          reason: "emergency",
        },
      ),
    ).rejects.toThrow(/Injected fault/);
    expect(await repo.listTickets("tenant_olivia")).toHaveLength(0);
  });
});
