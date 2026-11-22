import type { EvaluableRun, Evaluator } from "@/runtime/evaluation";

// Monitor (heuristic): every figure in an operations brief is backed by the fact it cites.
// The brief must write "… 6.1 hours [fact_key]": each number is paired with the first citation
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
// years, "per 100 homes", and coverage from the tools' notes ("2 of 3 months").
const NOT_FIGURES =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-(?:Q[1-4]|\d{2})(?:\.\.\d{4}-\d{2})?\b|\b(?:19|20)\d{2}\b|\bper 100 homes\b|\bQ[1-4]\b|\b\d+ (?:of|out of) \d+ months\b|\b\d+\/\d+\b/gi;
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

export function checkGrounding(reply: string, facts: Map<string, CitedFact>): GroundingProblem[] {
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
    const figuresOnly = sentence
      .replace(CITATION, (m) => " ".repeat(m.length))
      .replace(NOT_FIGURES, (m) => " ".repeat(m.length));
    for (const m of figuresOnly.matchAll(NUMBER)) tokens.push({ index: m.index, kind: "number", text: m[0] });
    tokens.sort((a, b) => a.index - b.index);

    for (const token of tokens) {
      if (token.kind === "number") {
        pending.push(token.text);
        continue;
      }
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

export const numbersGrounded: Evaluator = {
  id: "numbers_grounded",
  version: 1,
  kind: "monitor",
  description: "Every figure in an operations brief matches the fact it cites, for the agency it names",
  appliesTo: (run) => run.workflowId === "operations-brief" && /\d/.test((run.output ?? "").replace(NOT_FIGURES, "")),
  evaluate: (run) => {
    const problems = checkGrounding(run.output ?? "", factsOf(run));
    return problems.length === 0
      ? { verdict: "pass", evidence: "every figure matches the fact it cites" }
      : { verdict: "fail", evidence: problems.map((p) => p.problem).join("; ") };
  },
};
