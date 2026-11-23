// The conversation the ask box sends with each question, so a follow-up ("which rule failed in
// that run?") reaches the agent with the turns it refers to. Within the APIs' limits: at most
// 10 turns, each at most 4000 characters. Failed answers are left out — they carry no context.

export type AskAnswer = { question: string; reply: string; failed: boolean };

export const MAX_TURNS = 10;
export const MAX_CHARS = 4000;

// `answers` is newest first, as the box shows them; the history is oldest first.
export function historyFrom(answers: AskAnswer[]): { role: "user" | "assistant"; content: string }[] {
  const pairs = answers
    .filter((a) => !a.failed)
    .slice(0, MAX_TURNS / 2)
    .reverse();
  return pairs.flatMap((a) => [
    { role: "user" as const, content: a.question.slice(0, MAX_CHARS) },
    { role: "assistant" as const, content: a.reply.slice(0, MAX_CHARS) },
  ]);
}
