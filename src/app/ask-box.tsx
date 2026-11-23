"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { historyFrom } from "./ask-history";

// Ask a read-only agent about the page it sits on: the operations brief (managers) or the
// Inspector's quality analyst (engineers). The reply's citations ([fact_key]) are shown as small
// markers with the key on hover/focus, so the text stays readable while every figure stays traceable.

type Answer = { question: string; reply: string; runId?: string; failed: boolean };

function WithCitations({ text }: { text: string }) {
  const parts = text.split(/(\[[a-z0-9_.\-]+\])/gi);
  let n = 0;
  return (
    <>
      {parts.map((part, i) => {
        const key = /^\[([a-z0-9_.\-]+)\]$/i.exec(part)?.[1];
        if (!key) return <span key={i}>{part}</span>;
        n++;
        return (
          <sup key={i} title={key} tabIndex={0} aria-label={`source: ${key}`} className="mx-0.5 cursor-help rounded-sm bg-accent-soft px-1 font-mono text-[10px] text-accent">
            {n}
          </sup>
        );
      })}
    </>
  );
}

export function AskBox({
  id,
  endpoint,
  payload = {},
  heading,
  description,
  placeholder,
  examples,
  accessCode,
}: {
  // Prefix for element ids, so two boxes never share one.
  id: string;
  endpoint: "/api/operations-brief" | "/api/quality-assistant";
  // Extra request fields (e.g. the simulated manager session).
  payload?: Record<string, string>;
  heading: string;
  description: string;
  placeholder: string;
  examples: string[];
  accessCode: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const codeSuffix = accessCode ? `?code=${encodeURIComponent(accessCode)}` : "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;
    setPending(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(accessCode && { "x-demo-access-code": accessCode }) },
        // Earlier turns go with the question, so a follow-up keeps its context.
        body: JSON.stringify({ ...payload, requestId: crypto.randomUUID(), message: question, history: historyFrom(answers) }),
      });
      const body = await res.json();
      setAnswers((a) => [
        {
          question,
          reply: res.ok ? body.reply : res.status === 429 ? "Too many questions in a minute — please wait and try again." : "Something went wrong.",
          runId: res.ok && body.traceAvailable ? body.runId : undefined,
          failed: !res.ok || body.outcome === "failed",
        },
        ...a,
      ]);
      if (res.ok) setDraft("");
    } catch {
      setAnswers((a) => [{ question, reply: "The assistant couldn't be reached. Nothing was changed.", failed: true }, ...a]);
    } finally {
      setPending(false);
    }
  }

  // Enter asks, Shift+Enter adds a line; Enter belongs to an IME while it is composing.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-panel">
      <div>
        <h2 id={`${id}-heading`} className="text-title font-semibold">
          {heading}
        </h2>
        <p className="text-body-sm text-muted">{description}</p>
      </div>
      <form ref={formRef} onSubmit={onSubmit} aria-busy={pending} className="space-y-2">
        <label htmlFor={`${id}-question`} className="sr-only">
          Question
        </label>
        <textarea
          id={`${id}-question`}
          rows={2}
          maxLength={1000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={pending}
          placeholder={placeholder}
          className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-body disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-accent px-4 py-2 text-body font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? "Preparing…" : "Ask"}
          </button>
          {examples.map((e) => (
            <button key={e} type="button" onClick={() => setDraft(e)} className="rounded-md border border-border px-2 py-1 text-label text-muted hover:bg-subtle">
              {e}
            </button>
          ))}
        </div>
      </form>
      <div role="log" aria-live="polite" className="space-y-3">
        {answers.map((a, i) => (
          <article key={i} className={`space-y-1 rounded-md p-3 ${a.failed ? "border border-error" : "bg-subtle"}`}>
            <p className="text-label text-muted">{a.question}</p>
            <div className="whitespace-pre-wrap text-body">
              <WithCitations text={a.reply} />
            </div>
            {a.runId && (
              <a href={`/inspector/${a.runId}${codeSuffix}`} className="text-label text-muted underline-offset-2 hover:text-accent hover:underline">
                View trace →
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
