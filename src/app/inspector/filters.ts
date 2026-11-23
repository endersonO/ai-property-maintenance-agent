// The Inspector's ?failing= filter. Accepted forms:
//   rules | alarms | errors | any                — the headline's sets;
//   <evaluator id>:fail | <evaluator id>:error   — one check, one verdict;
//   <evaluator id>                               — links saved before verdicts were split: it keeps
//                                                  its meaning, failed or couldn't run.
// Anything else — including a repeated parameter — is reported as dropped, never silently ignored.
export const SETS = ["rules", "alarms", "errors", "any"] as const;

export type ParsedFilter = {
  failing: string | null;
  evaluatorId: string | null;
  verdict: "fail" | "error" | null;
  dropped: string | null;
};

export function parseFailingFilter(param: string | string[] | undefined, evaluatorIds: string[]): ParsedFilter {
  const none = { failing: null, evaluatorId: null, verdict: null, dropped: null };
  // Repeated (?failing=a&failing=b): one filter at a time, so it's reported, not guessed.
  if (Array.isArray(param)) return param.length === 0 ? none : { ...none, dropped: param.join(", ") };
  if (param === undefined || param === "") return none;
  if ((SETS as readonly string[]).includes(param)) return { ...none, failing: param };
  const [id, verdict, ...rest] = param.split(":");
  if (evaluatorIds.includes(id) && rest.length === 0) {
    if (verdict === undefined) return { ...none, failing: id, evaluatorId: id };
    if (verdict === "fail" || verdict === "error") return { failing: `${id}:${verdict}`, evaluatorId: id, verdict, dropped: null };
  }
  return { ...none, dropped: param };
}
