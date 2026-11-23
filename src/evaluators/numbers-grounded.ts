import type { EvaluableRun, Evaluator } from "@/runtime/evaluation";

// Monitor (heuristic): every figure in an operations brief or a quality-analyst answer is backed
// by the fact it cites. The answer must write "… 6.1 hours [fact_key]": each number is paired with the first citation
// after it in the same sentence, and
//   - the cited key must be a fact returned by a successful tool call in this run;
//   - the number must equal the fact's value at the precision written (6.1 matches 6.12; 6 matches 6.4);
//     a negative value may be written as its magnitude with a word for the direction ("down 19.5%");
//   - the last agency named before the citation must be the fact's agency (or the fact is for "all").
// So "Northbridge takes 8 h [a Harbour Lane fact]" fails even though 8 is a real value. Checking
// free text against numbers can't be exhaustive (paraphrased figures, words like "half"), hence
// a monitor: it flags runs for triage, it doesn't gate CI.

// n: the observations behind a statistic ("100% of 43 tickets" cites a share whose n is 43).
type CitedFact = { key: string; metric?: string; agency: string; value: number; n?: number };

const CITATION = /\[([a-z0-9_.\-]+)\]/gi;
// Numbers that are not figures: dates and period labels (2026-11-01, 2026-Q3, 2025-11..2026-10),
// times (00:12), years, "per 100 homes", coverage from the tools' notes ("2 of 3 months"), and
// full ids (a UUID's "-1234" is not a figure). Short 8-character refs are skipped only when they
// are a prefix of an id the tools returned (see knownRefs): "12345678 runs" is still a figure.
const NOT_FIGURES =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-(?:Q[1-4]|\d{2})(?:\.\.\d{4}-\d{2})?\b|\b(?:19|20)\d{2}\b|\bper 100 homes\b|\bQ[1-4]\b|\b\d+ (?:of|out of) \d+ months\b|\b\d+\/\d+\b|\b\d{1,2}:\d{2}\b/gi;
// Words that carry the sign of a negative change written as a magnitude.
const DECREASE = /\b(?:down|decrease[ds]?|fell|fall|dropped|drop|lower|fewer|declined?|reduction|less)\b/i;
// A figure, with its sign when one is written ("-5", "−5").
const NUMBER = /(?<![\w.])[-−]?\d+(?:[.,]\d+)?(?![\w])/g;

function factsOf(run: EvaluableRun): Map<string, CitedFact> {
  const facts = new Map<string, CitedFact>();
  for (const call of run.toolCalls) {
    if (!call.result.ok) continue;
    const data = call.result.data as { facts?: CitedFact[] };
    for (const f of data?.facts ?? []) facts.set(f.key, { key: f.key, metric: f.metric, agency: f.agency, value: f.value, n: f.n });
  }
  return facts;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHORT_REF = /\b[0-9a-f]{8}\b/gi;

// What the tools returned, beyond facts: the 8-character refs of every id (e.g. run_ref
// "3f2a9c1b"), and all their text, so a figure QUOTED from it (in backticks, e.g. evidence
// "`25` is not followed by a citation") is recognised as a quotation, not a claim.
export type GroundingContext = { refs: Set<string>; toolText: string };

function contextOf(run: EvaluableRun): GroundingContext {
  const texts = run.toolCalls.filter((c) => c.result.ok).map((c) => JSON.stringify(c.result.ok ? (c.result.data ?? null) : null));
  const refs = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(UUID)) refs.add(m[0].slice(0, 8).toLowerCase());
  return { refs, toolText: texts.join("\n") };
}

const NO_CONTEXT: GroundingContext = { refs: new Set(), toolText: "" };
const blank = (m: string) => " ".repeat(m.length);

// Blanks what is not a figure, keeping offsets: the fixed patterns, the known short refs, and
// backtick quotations that appear verbatim in the tools' results (an invented quote stays).
const blankNonFigures = (text: string, context: GroundingContext) =>
  text
    .replace(/`([^`\n]+)`/g, (m, inner: string) => (context.toolText.includes(inner) ? blank(m) : m))
    .replace(NOT_FIGURES, blank)
    .replace(SHORT_REF, (m) => (context.refs.has(m.toLowerCase()) ? blank(m) : m));

const isChange = (fact: CitedFact) => (fact.metric ?? fact.key).startsWith("change_");

// A written number matches a value at the precision it was written with. An explicit sign is
// always respected. For a change written without a sign, the words decide its direction:
// "fell 5%" means -5 and "rose 5%"/"5%" means +5 — so "fell 5%" for a +5 change fails. Other
// metrics never take a direction from words ("a lower median of 6.1 hours" is 6.1).
function matches(written: string, fact: CitedFact, context: string): boolean {
  const normal = written.replace("−", "-").replace(",", ".");
  const decimals = normal.includes(".") ? normal.split(".")[1].length : 0;
  const explicitSign = normal.startsWith("-");
  const magnitude = Math.abs(Number(normal));
  const claimed = explicitSign || !isChange(fact) ? Number(normal) : DECREASE.test(context) ? -magnitude : magnitude;
  return Math.abs(claimed - fact.value) <= 0.5 * 10 ** -decimals + 1e-9;
}

// "Riverside Homes" is named by "Riverside" (its first word).
const firstWord = (agency: string) => agency.replace(/^agency_/, "").split(/[\s_]/)[0];

// The agency named last before `end` in the sentence, among the agencies the facts mention.
function lastNamedAgency(sentence: string, end: number, agencies: string[]): string | null {
  let best: { agency: string; index: number } | null = null;
  for (const agency of agencies) {
    const word = firstWord(agency).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of sentence.slice(0, end).matchAll(new RegExp(`\\b${word}`, "gi"))) {
      if (!best || m.index > best.index) best = { agency, index: m.index };
    }
  }
  return best?.agency ?? null;
}

export type GroundingProblem = { sentence: string; problem: string };

export function checkGrounding(
  reply: string,
  facts: Map<string, CitedFact>,
  context: GroundingContext = NO_CONTEXT,
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const agencies = [...new Set([...facts.values()].map((f) => f.agency))].filter((a) => !/^all\b/i.test(a));
  // Citation keys contain dots: mask them before finding sentence boundaries.
  const masked = reply.replace(CITATION, (m) => "#".repeat(m.length));
  // A sentence runs to . ! ? or a newline; a point followed by a digit is a decimal, not an end.
  for (const range of masked.matchAll(/(?:[^.!?\n]|[.!?](?=\d))+(?:[.!?]|\n|$)/g)) {
    const sentence = reply.slice(range.index, range.index + range[0].length);
    // Walk the sentence: numbers wait for the next citation, which closes a segment.
    const pending: string[] = [];
    let segmentStart = 0;
    const tokens: { index: number; kind: "number" | "citation"; text: string }[] = [];
    // Citations first (their keys contain period labels), then blank them and the non-figures.
    for (const m of sentence.matchAll(CITATION)) tokens.push({ index: m.index, kind: "citation", text: m[1] });
    const figuresOnly = blankNonFigures(sentence.replace(CITATION, blank), context);
    for (const m of figuresOnly.matchAll(NUMBER)) tokens.push({ index: m.index, kind: "number", text: m[0] });
    tokens.sort((a, b) => a.index - b.index);

    for (const token of tokens) {
      if (token.kind === "number") {
        pending.push(token.text);
        continue;
      }
      // A run ref in brackets ("[3f2a9c1b]") names a run; it is not a citation.
      if (!facts.has(token.text) && context.refs.has(token.text.toLowerCase())) continue;
      const fact = facts.get(token.text);
      const segment = sentence.slice(segmentStart, token.index);
      segmentStart = token.index + token.text.length + 2;
      if (!fact) {
        // A bracketed label with no figure ("[dataset]") backs nothing and claims nothing.
        if (pending.length > 0) {
          problems.push({ sentence: sentence.trim(), problem: `cites [${token.text}], which no tool returned` });
        }
        pending.length = 0;
        continue;
      }
      const [first, ...extra] = pending.splice(0);
      if (first === undefined) continue; // a citation with no figure: harmless
      if (!matches(first, fact, segment)) {
        problems.push({ sentence: sentence.trim(), problem: `${first} does not match [${fact.key}] = ${fact.value}` });
      }
      // A second figure may be the cited statistic's own n; anything else needs its own citation.
      for (const n of extra) {
        if (fact.n !== undefined && Number(n) === fact.n) continue;
        problems.push({ sentence: sentence.trim(), problem: `${n} has no citation of its own` });
      }
      if (!/^all\b/i.test(fact.agency)) {
        const named = lastNamedAgency(sentence, token.index, agencies);
        if (named !== fact.agency) {
          problems.push({
            sentence: sentence.trim(),
            problem: `[${fact.key}] is about ${fact.agency}, but the sentence ${named ? `is talking about ${named}` : "names no agency"}`,
          });
        }
      }
    }
    for (const n of pending) problems.push({ sentence: sentence.trim(), problem: `${n} is not followed by a citation` });
  }
  return problems;
}

// Workflows whose answers must cite every figure.
const CITING_WORKFLOWS = new Set(["operations-brief", "quality-analyst"]);

export const numbersGrounded: Evaluator = {
  id: "numbers_grounded",
  version: 2,
  kind: "monitor",
  description: "Every figure in an operations brief or a quality answer matches the fact it cites, for the agency it names",
  appliesTo: (run) =>
    CITING_WORKFLOWS.has(run.workflowId) &&
    /\d/.test(blankNonFigures((run.output ?? "").replace(CITATION, ""), contextOf(run))),
  evaluate: (run) => {
    const problems = checkGrounding(run.output ?? "", factsOf(run), contextOf(run));
    return problems.length === 0
      ? { verdict: "pass", evidence: "every figure matches the fact it cites" }
      : { verdict: "fail", evidence: problems.map((p) => p.problem).join("; ") };
  },
};
