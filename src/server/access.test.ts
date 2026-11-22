import { describe, expect, it } from "vitest";
import { checkAccess } from "./access";
import { SlidingWindowLimiter } from "./limits";

describe("checkAccess", () => {
  it("grants everything when no code is configured", () => {
    expect(checkAccess(null, "c", undefined, new SlidingWindowLimiter(1, 1000))).toBe("granted");
  });

  it("locks a client out after repeated wrong codes, even if it then guesses right", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const attempt = (code: string, client = "attacker") => checkAccess(code, client, "secret", limiter);

    expect(attempt("a")).toBe("denied");
    expect(attempt("b")).toBe("denied");
    expect(attempt("c")).toBe("locked");
    expect(attempt("secret")).toBe("locked");
    // Other clients are unaffected.
    expect(attempt("secret", "someone-else")).toBe("granted");
  });
});
