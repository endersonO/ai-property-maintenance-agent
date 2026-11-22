"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { TicketSummary } from "@/server/chat";
import { EmergencyNotice, Icon, safetyGuidanceFor, TicketCard } from "./ui";

type Safety = { title: string; steps: string[] };
type Turn = { role: "user" | "assistant"; content: string; failed?: boolean; safety?: Safety | null };

const EXAMPLE = "Water is leaking from my ceiling";

export function PortalChat({
  tenantId,
  tenantName,
  initialTickets,
}: {
  tenantId: string;
  tenantName: string;
  initialTickets: TicketSummary[];
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tickets, setTickets] = useState(initialTickets);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const logRef = useRef<HTMLOListElement>(null);

  // Keep the latest message in view.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, pending]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || pending) return;

    // The server keeps no conversation: send prior text turns, excluding failed replies.
    const history = turns
      .filter((t) => !t.failed)
      .map(({ role, content }) => ({ role, content }))
      .slice(-20);
    setTurns((t) => [...t, { role: "user", content: message }]);
    setDraft("");
    setPending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, requestId: crypto.randomUUID(), message, history }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: {
        outcome: "completed" | "failed";
        reply: string;
        tickets: TicketSummary[];
        createdTicketIds: string[];
      } = await res.json();

      const created = body.tickets.filter((t) => body.createdTicketIds.includes(t.id));
      const safety = created.map(safetyGuidanceFor).find(Boolean) ?? null;
      setTurns((t) => [
        ...t,
        { role: "assistant", content: body.reply, failed: body.outcome === "failed", safety },
      ]);
      setTickets(body.tickets);
    } catch {
      setTurns((t) => [
        ...t,
        { role: "assistant", content: "I couldn't reach the service, so nothing was sent. Please try again.", failed: true },
      ]);
    } finally {
      setPending(false);
    }
  }

  // Enter sends, Shift+Enter adds a line. Never submit while an IME is composing text.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      formRef.current?.requestSubmit();
    }
  }

  return (
    <div className="grid gap-6 min-[960px]:grid-cols-[3fr_2fr]">
      <section
        aria-labelledby="chat-heading"
        className="flex min-h-[32rem] flex-col rounded-lg border border-border bg-surface shadow-panel"
      >
        <h2 id="chat-heading" className="border-b border-border px-5 py-4 text-title font-semibold">
          Report a problem
        </h2>

        <ol ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="flex-1 space-y-4 overflow-y-auto p-5">
          {turns.length === 0 && (
            <li className="space-y-3 py-8 text-center">
              <p className="text-body-lg">Hi {tenantName}. Tell me what&apos;s wrong in your home.</p>
              <button
                type="button"
                onClick={() => setDraft(EXAMPLE)}
                className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-body hover:bg-subtle"
              >
                Try: &ldquo;{EXAMPLE}&rdquo;
              </button>
            </li>
          )}
          {turns.map((turn, i) => (
            <li key={i} className={turn.role === "user" ? "flex justify-end" : "flex flex-col items-start"}>
              <div
                className={
                  "max-w-[85%] whitespace-pre-wrap px-4 py-3 text-body-lg " +
                  (turn.role === "user"
                    ? "rounded-xl rounded-br-sm bg-accent text-accent-text"
                    : turn.failed
                      ? "rounded-xl rounded-bl-sm border border-error bg-surface"
                      : "rounded-xl rounded-bl-sm bg-subtle")
                }
              >
                <span className="sr-only">{turn.role === "user" ? "You: " : "Assistant: "}</span>
                {turn.failed && (
                  <span className="mb-1 flex items-center gap-1.5 text-heading font-semibold text-error">
                    <Icon name="alertFill" className="size-4" />
                    Reply not finished
                  </span>
                )}
                {turn.content}
              </div>
              {turn.safety && <EmergencyNotice title={turn.safety.title} steps={turn.safety.steps} />}
            </li>
          ))}
          {pending && (
            <li className="flex items-center gap-2 text-body text-muted" aria-hidden="true">
              <span className="flex gap-1">
                <span className="lo-dot size-1.5 rounded-full bg-muted" />
                <span className="lo-dot size-1.5 rounded-full bg-muted [animation-delay:0.15s]" />
                <span className="lo-dot size-1.5 rounded-full bg-muted [animation-delay:0.3s]" />
              </span>
              Assistant is working…
            </li>
          )}
        </ol>

        <p role="status" className="sr-only">
          {pending ? "Assistant is working" : ""}
        </p>

        <form ref={formRef} onSubmit={onSubmit} className="border-t border-border p-4" aria-busy={pending}>
          <div className="flex gap-2">
            <label htmlFor="message" className="sr-only">
              Message
            </label>
            <textarea
              id="message"
              name="message"
              required
              maxLength={1000}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={pending}
              aria-describedby="composer-hint"
              placeholder="Describe the problem…"
              className="flex-1 resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-body-lg disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-w-24 items-center justify-center gap-1.5 self-end rounded-md bg-accent px-4 py-2 text-body font-medium text-accent-text hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="send" />
              {pending ? "Sending…" : "Send"}
            </button>
          </div>
          <p id="composer-hint" className="mt-2 text-label text-muted">
            Enter to send · Shift+Enter for a new line
          </p>
        </form>
      </section>

      <section aria-labelledby="tickets-heading" className="space-y-3">
        <h2 id="tickets-heading" className="text-title font-semibold">
          Your tickets
        </h2>
        {tickets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-body text-muted">
            No tickets yet. When you report a problem, it will appear here with its priority and status.
          </p>
        ) : (
          <ul aria-label="Your tickets" className="space-y-3">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <TicketCard ticket={ticket} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
