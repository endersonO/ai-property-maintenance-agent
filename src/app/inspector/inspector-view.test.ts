import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunOutcomeCell } from "./components";
import { ChecksTable, StatusLine } from "./quality";
import { evaluators } from "@/evaluators";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const noTickets = { tickets: [], reviewsPending: 0, reviewsTotal: 0 };
const leak = { tickets: [{ id: "547bf635-453a-4d69-ad12-efbd3662f1da", priority: "emergency", status: "open", escalated: false, updated: false }], reviewsPending: 1, reviewsTotal: 1 };

describe("Inspector view", () => {
  it("a running run is 'still running', never 'replied' or 'answered'", () => {
    const html = text(renderToString(createElement(RunOutcomeCell, { outcome: noTickets, workflowId: "maintenance", status: "running", error: null })));
    expect(html).toContain("Still running");
    expect(html).not.toMatch(/Replied|Answered/);
  });

  it("a run that failed after creating a ticket shows both the ticket and the failure", () => {
    const html = text(renderToString(createElement(RunOutcomeCell, { outcome: leak, workflowId: "maintenance", status: "failed", error: "timeout" })));
    expect(html).toContain("Created emergency ticket #547bf635");
    expect(html).toContain("The agent failed after this (timeout)");
  });

  it("a run that only added details to an older ticket says so, not 'Created' or 'Escalated'", () => {
    const updated = { ...leak, tickets: [{ ...leak.tickets[0], updated: true }], reviewsPending: 0, reviewsTotal: 0 };
    const html = text(renderToString(createElement(RunOutcomeCell, { outcome: updated, workflowId: "maintenance", status: "completed", error: null })));
    expect(html).toContain("Added details to emergency ticket #547bf635");
    expect(html).not.toMatch(/Created|Escalated/);
  });

  const summary = { finished: 3, checked: 0, pending: 3, brokenRules: 0, flagged: 0, checkErrors: 0 };
  const raw = (s: Partial<typeof summary>) =>
    renderToString(createElement(StatusLine, { summary: { ...summary, ...s }, hrefFor: (set) => `/inspector?failing=${set}` }));
  const status = (s: Partial<typeof summary>) => text(raw(s));

  it("is never green without a single checked run", () => {
    expect(status({})).toContain("Pending evaluation: none of 3 runs checked yet");
    expect(status({})).not.toContain("behaving");
    expect(status({ checked: 3, pending: 0 })).toContain("no broken rules in 3 checked runs");
  });

  it("a check that couldn't run is not announced as a broken rule", () => {
    const html = status({ checked: 3, pending: 0, checkErrors: 1 });
    expect(html).toContain("No broken rules");
    expect(html).toContain("1 with a check that couldn't run (unknown, not a failure)");
    expect(html).not.toMatch(/rule was broken/);
  });

  it("each count links to the filter of exactly the runs it counts", () => {
    const html = raw({ checked: 3, pending: 0, brokenRules: 1, flagged: 1, checkErrors: 1 });
    expect(text(html)).toContain("A rule was broken in 1 run");
    expect(html).toContain('href="/inspector?failing=rules"');
    expect(html).toContain('href="/inspector?failing=alarms"');
    expect(html).toContain('href="/inspector?failing=errors"');
    expect(html).not.toContain("failing=any");
  });

  it("the checks table keeps a check that couldn't run apart from a failure", () => {
    const row = { evaluatorId: "emergency_reviewed", agencyId: "agency_northbridge", agency: "Northbridge Lettings", workflowId: "maintenance", eligible: 10, pass: 9, fail: 0, notApplicable: 0, error: 1, pending: 0 };
    const html = text(renderToString(createElement(ChecksTable, { rows: [row], evaluators: evaluators.slice(0, 1), flaggedHref: () => "#" })));
    expect(html).toContain("9 of 9 passed");
    expect(html).toContain("1 couldn't run");
    expect(html).not.toContain("1 failed");
    // The per-agency breakdown keeps it too.
    expect(html).toContain("9 passed, 0 failed, 0 not applicable, 1 couldn't run");
  });
});
