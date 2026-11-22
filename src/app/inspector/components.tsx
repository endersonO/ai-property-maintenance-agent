import { Icon } from "../ui";

// Operator components following design/HomeFix. Rejected (a guardrail held) and error
// (something broke) differ in hue, icon and line style, so they stay distinct in greyscale.

const OUTCOME = {
  ok: { label: "ok", className: "bg-ok-soft text-ok", icon: "check" },
  completed: { label: "completed", className: "bg-ok-soft text-ok", icon: "check" },
  rejected: { label: "rejected", className: "bg-rejected-soft text-rejected border border-dashed border-rejected", icon: "shield" },
  error: { label: "error", className: "bg-error-soft text-error border border-error", icon: "alertFill" },
  failed: { label: "failed", className: "bg-error-soft text-error border border-error", icon: "alertFill" },
  running: { label: "running", className: "bg-subtle text-muted", icon: null },
} as const;

export function OutcomeBadge({ status }: { status: string }) {
  const o = OUTCOME[status as keyof typeof OUTCOME] ?? OUTCOME.running;
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-label font-medium ${o.className}`}>
      {o.icon && <Icon name={o.icon} className="size-3.5" />}
      {o.label}
    </span>
  );
}

const STAGES = ["validate", "authorize", "policy", "idempotency", "execute"] as const;

export function PipelineStages({ stoppedAt, status }: { stoppedAt: string | null; status: string }) {
  const stopIndex = STAGES.indexOf((stoppedAt ?? "execute") as (typeof STAGES)[number]);
  return (
    <ol aria-label="Executor pipeline" className="flex flex-wrap items-center gap-1 font-mono text-label">
      {STAGES.map((stage, i) => {
        const state = i < stopIndex || (i === stopIndex && status === "ok") ? "passed" : i === stopIndex ? status : "not reached";
        const style =
          state === "passed"
            ? "bg-ok-soft text-ok"
            : state === "rejected"
              ? "bg-rejected-soft text-rejected border border-dashed border-rejected"
              : state === "error"
                ? "bg-error-soft text-error border border-error"
                : "border border-dashed border-border text-muted";
        return (
          <li key={stage} className={`rounded-sm px-1.5 py-0.5 ${style}`}>
            {stage}
            <span className="sr-only">: {state}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return (
    <figure className="space-y-1">
      <figcaption className="text-label text-muted">{label}</figcaption>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-72 overflow-auto rounded-sm bg-subtle p-3 font-mono text-[13px] leading-5"
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </figure>
  );
}

export const fmtMs = (ms: number | null) => (ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);

// Horizontal verdicts for one run: flagged (fail or error) stands out; pending is explicit.
export function ChecksCell({ checks }: { checks: { flagged: number; pending: number } }) {
  if (checks.flagged > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-error bg-error-soft px-2 py-0.5 text-label font-medium text-error">
        <Icon name="alertFill" className="size-3.5" />
        {checks.flagged} flagged
      </span>
    );
  }
  if (checks.pending > 0) return <span className="text-label text-muted">{checks.pending} pending</span>;
  return (
    <span className="inline-flex items-center gap-1 text-label text-ok">
      <Icon name="check" className="size-3.5" />
      clear
    </span>
  );
}

const VERDICT = {
  pass: "bg-ok-soft text-ok",
  fail: "bg-error-soft text-error border border-error",
  error: "bg-error-soft text-error border border-dashed border-error",
  "n/a": "bg-subtle text-muted",
  pending: "border border-dashed border-border-strong text-muted",
} as const;

export function VerdictBadge({ verdict }: { verdict: keyof typeof VERDICT }) {
  return <span className={`rounded-sm px-2 py-0.5 text-label font-medium ${VERDICT[verdict]}`}>{verdict}</span>;
}
