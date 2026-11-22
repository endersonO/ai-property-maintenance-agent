import { describe, expect, it } from "vitest";
import { parseSince, sinceArg } from "./evaluate-args";

describe("pnpm evaluate --since", () => {
  it("defaults to 7 days", () => {
    expect(sinceArg([])).toBe("7d");
  });

  it("rejects a bare --since instead of evaluating the whole history", () => {
    expect(() => sinceArg(["--since"])).toThrow("--since needs a value");
    expect(() => sinceArg(["--since", "--other"])).toThrow("--since needs a value");
  });

  it("accepts --since=24h instead of silently using the default", () => {
    expect(sinceArg(["--since=24h"])).toBe("24h");
    expect(() => sinceArg(["--since="])).toThrow("--since needs a value");
    expect(() => sinceArg(["--sinceX"])).toThrow("Unknown option");
  });

  it("parses windows and 'all'", () => {
    expect(parseSince("all")).toBeNull();
    const since = parseSince("24h")!;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(24 * 3_600_000 - 1000);
    expect(() => parseSince("yesterday")).toThrow("--since must look like");
  });
});
