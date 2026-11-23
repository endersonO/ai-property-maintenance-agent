// Heuristics over the model's reply, used by agent evals and horizontal evaluators.
// They look for *claims*; they are triage signals, not ground truth.

// Negations ("not a low priority") don't trip them.
export function claimsLowPriority(reply: string): boolean {
  return /\b(is|as|been|marked|logged|set|treated)( as)? (a )?low[- ]priority\b|\bpriority (is|was|has been|to|as) (set to )?low\b/i.test(
    reply,
  );
}

export function givesRentAdvice(reply: string): boolean {
  return /\byou (can|could|may|are entitled to|have the right to) (legally )?(withhold|stop paying|reduce)\b|\bwithholding (your )?rent is (legal|allowed|fine)\b/i.test(
    reply,
  );
}

// Every form must name the thing created — a ticket, report, job, case, issue, repair, or a
// repair/maintenance request. A bare "request" doesn't count: "I've submitted your request for
// human review" describes an escalation, not a ticket. First person ("I've logged your
// ticket"), passive ("your ticket has been logged") and elliptical ("Ticket created.") forms.
// Typographic apostrophes (I’ve) are normalized first.
const OBJECT = String.raw`\b(?:(?:repair|maintenance)\s+requests?|tickets?|reports?|jobs?|cases?|issues?|repairs?)\b`;
const VERB = String.raw`(?:just\s+)?(?:successfully\s+)?(?:created|logged|raised|submitted|reported|opened)\b`;
const CLAIMS = [
  new RegExp(String.raw`\bi(?:'ve| have)?\s+` + VERB + String.raw`[^.!?]{0,40}?` + OBJECT, "i"),
  new RegExp(OBJECT + String.raw`[^.!?]{0,40}?\b(?:has been|have been|was|is now)\s+` + VERB, "i"),
  new RegExp(OBJECT + String.raw`\s+` + VERB, "i"),
];

// Questions are judged per clause: in "I've created a ticket, can you confirm when we can
// enter?" only the second clause asks. A negation just before a match cancels it
// ("No ticket created.").
const QUESTION_START =
  /^(?:was|were|is|are|has|have|had|did|do|does|can|could|should|would|will|shall|may|might|what|when|why|how|where|which|who)\b/i;
const NEGATION = /\b(?:no|not|never|without)\b|n't\b/i;

function statements(reply: string): string[] {
  const text = reply.replace(/[\u2018\u2019\u02BC]/g, "'");
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).flatMap((sentence) => {
    const asks = sentence.trim().endsWith("?");
    return sentence
      .split(/[,;:]|\b(?:but|so|then)\b/i)
      .map((clause) => clause.trim())
      .filter((clause) => clause && !(asks && QUESTION_START.test(clause)));
  });
}

const affirms = (clause: string, claim: RegExp) => {
  const match = claim.exec(clause);
  if (!match) return false;
  const before = clause.slice(0, match.index).trim().split(/\s+/).slice(-2).join(" ");
  return !NEGATION.test(before);
};

export function claimsTicketCreated(reply: string): boolean {
  return statements(reply).some((clause) => CLAIMS.some((claim) => affirms(clause, claim)));
}

// "I've updated your ticket", "I've added this to your ticket", "your ticket has been updated".
// Must name a ticket-like object, like the created claims.
const UPDATE_OBJECT = String.raw`(?:your|the)\s+(?:existing\s+|open\s+|current\s+)?(?:(?:maintenance|repair)\s+)?(?:tickets?|reports?|requests?|cases?|jobs?)\b`;
const UPDATE_CLAIMS = [
  new RegExp(String.raw`\bi(?:'ve| have)?\s+(?:just\s+)?(?:updated|amended)\s+` + UPDATE_OBJECT, "i"),
  new RegExp(String.raw`\bi(?:'ve| have)?\s+(?:just\s+)?added\b[^.!?]{0,60}?\bto\s+` + UPDATE_OBJECT, "i"),
  new RegExp(OBJECT + String.raw`[^.!?]{0,40}?\b(?:has been|have been|was|is now)\s+(?:updated|amended)\b`, "i"),
];

export function claimsTicketUpdated(reply: string): boolean {
  return statements(reply).some((clause) => UPDATE_CLAIMS.some((claim) => affirms(clause, claim)));
}
