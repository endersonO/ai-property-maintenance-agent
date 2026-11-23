import { describe, expect, it } from "vitest";
import { BriefRequest } from "@/server/operations-brief";
import { QualityRequest } from "@/server/quality-assistant";
import { historyFrom, type AskAnswer } from "./ask-history";

const answer = (n: number, failed = false): AskAnswer => ({ question: `q${n}`, reply: `a${n}`, failed });

describe("historyFrom", () => {
  it("sends earlier turns oldest first, so a follow-up keeps its context", () => {
    // Newest first, as the box keeps them.
    expect(historyFrom([answer(2), answer(1)])).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("keeps the latest turns within the APIs' limits, and leaves failed answers out", () => {
    const many = [answer(9, true), ...Array.from({ length: 8 }, (_, i) => answer(8 - i))];
    const history = historyFrom(many);
    expect(history.map((t) => t.content).filter((c) => c.startsWith("q"))).toEqual(["q4", "q5", "q6", "q7", "q8"]);
    const long = historyFrom([{ question: "q", reply: "x".repeat(9000), failed: false }]);
    // Both endpoints accept what the box sends.
    for (const h of [history, long]) {
      const body = { requestId: crypto.randomUUID(), message: "and that run?", history: h };
      expect(QualityRequest.safeParse(body).success).toBe(true);
      expect(BriefRequest.safeParse({ ...body, managerId: "manager_ops" }).success).toBe(true);
    }
  });
});
