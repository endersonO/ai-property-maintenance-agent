import { describe, expect, it } from "vitest";
import { MissingDependency, parseOnly, SCENARIOS, ticketFrom, type ChatReply } from "./demo-conversations";

describe("demo-conversations --only", () => {
  it("accepts both the documented and the = syntax", () => {
    expect(parseOnly(["--only", "olivia-gas,brief-trend"])).toEqual(new Set(["olivia-gas", "brief-trend"]));
    expect(parseOnly(["--only=olivia-gas,brief-trend"])).toEqual(new Set(["olivia-gas", "brief-trend"]));
  });

  it("runs everything only when nothing is passed", () => {
    expect(parseOnly([])).toBeNull();
  });

  it("stops on anything it doesn't understand instead of sending every conversation", () => {
    expect(() => parseOnly(["--only"])).toThrow(/needs a comma-separated list/);
    expect(() => parseOnly(["--only", "olivia-gaz"])).toThrow(/Unknown scenario\(s\): olivia-gaz/);
    expect(() => parseOnly(["olivia-gas"])).toThrow(/did you mean --only olivia-gas/);
    expect(() => parseOnly(["--onyl=olivia-gas"])).toThrow(/Unknown option --onyl=olivia-gas/);
    expect(() => parseOnly(["--only", "olivia-gas", "brief-trend"])).toThrow(/Unexpected argument brief-trend/);
  });
});

describe("demo-conversations dependencies", () => {
  const reply = (ticket?: string): ChatReply => ({ runId: "r", outcome: "completed", reply: "", createdTicketIds: ticket ? [ticket] : [] });

  it("a scenario selected without the one it depends on stops before any request", () => {
    expect(() => parseOnly(["--only", "priya-short-ref"])).toThrow(/priya-short-ref needs priya-lock/);
    expect(() => parseOnly(["--only=james-foreign-ticket"])).toThrow(/james-foreign-ticket needs olivia-gas/);
    expect(parseOnly(["--only", "olivia-gas,james-foreign-ticket"])).toEqual(new Set(["olivia-gas", "james-foreign-ticket"]));
  });

  it("every dependent turn refuses to build a message without a real ticket, and uses it when there is one", () => {
    for (const sc of SCENARIOS) {
      if (sc.kind !== "tenant") continue;
      for (const turn of sc.turns) {
        if (typeof turn === "string") continue;
        // Declared, so --only can check it.
        expect(sc.dependsOn?.length, sc.id).toBeGreaterThan(0);
        // The dependency ran but created no ticket: no placeholder message.
        const noTicket = new Map(sc.dependsOn!.map((d) => [d, reply()]));
        expect(() => turn(noTicket), sc.id).toThrow(MissingDependency);
        const ticket = "5c78fd92-69e9-4d6a-b088-5439455da12d";
        const withTicket = new Map(sc.dependsOn!.map((d) => [d, reply(ticket)]));
        expect(turn(withTicket), sc.id).toContain(ticket.slice(0, 8));
      }
    }
  });

  it("ticketFrom names what is missing", () => {
    expect(() => ticketFrom(new Map(), "olivia-gas")).toThrow(/needs a ticket from olivia-gas/);
  });
});
