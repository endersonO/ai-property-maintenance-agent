import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./limits";

describe("SlidingWindowLimiter", () => {
  it("allows up to max per window per key, then frees slots as they age out", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1000, () => now);

    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(limiter.take("b").ok).toBe(true);

    now = 1000;
    expect(limiter.take("a").ok).toBe(true);
  });
});
