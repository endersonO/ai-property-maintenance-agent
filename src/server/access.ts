import { SlidingWindowLimiter } from "./limits";

// Demo gate, not authentication: when DEMO_ACCESS_CODE is set (public deploy), pages and the
// chat API require it, so strangers can't spend the model quota or read traces.
// Failed attempts are limited per client, so the code can't be brute-forced.

const failedAttempts = new SlidingWindowLimiter(10, 15 * 60_000);

export type AccessDecision = "granted" | "denied" | "locked";

export function checkAccess(
  code: string | string[] | null | undefined,
  client: string,
  expected: string | undefined = process.env.DEMO_ACCESS_CODE || undefined,
  limiter: SlidingWindowLimiter = failedAttempts,
): AccessDecision {
  if (!expected) return "granted";
  if (limiter.isBlocked(client)) return "locked";
  if (code === expected) return "granted";
  limiter.take(client);
  return limiter.isBlocked(client) ? "locked" : "denied";
}

// Query suffix that keeps the code on internal links.
export const withCode = (code: string | string[] | undefined) =>
  typeof code === "string" && code ? `?code=${encodeURIComponent(code)}` : "";
