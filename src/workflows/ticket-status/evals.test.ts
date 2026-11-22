import { describe, expect, it } from "vitest";
import { statesOpenEmergency } from "./evals";

describe("statesOpenEmergency", () => {
  it.each([
    ["Your leak is logged as an emergency and it's still open.", true],
    ["It's an open emergency ticket; a person at the agency is reviewing it.", true],
    ["This is not an emergency and the ticket is not open.", false],
    ["Your ticket is no longer open.", false],
    ["I couldn't find that ticket.", false],
  ])("%j → %s", (reply, expected) => {
    expect(statesOpenEmergency(reply)).toBe(expected);
  });
});
