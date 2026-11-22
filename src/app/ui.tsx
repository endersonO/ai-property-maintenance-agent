import type { TicketSummary } from "@/server/chat";

// Portal components following design/HomeFix. Meaning is never carried by colour alone:
// every badge has a word, and icons are aria-hidden.

const ICONS: Record<string, string[]> = {
  alert: ["M12 3.5 2.8 19.5h18.4z", "M12 10v4", "M12 17h.01"],
  shield: ["M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6z", "M9 12h6"],
  person: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20.5c1.2-3.5 4-5 7.5-5s6.3 1.5 7.5 5"],
  check: ["M5 12.5 10 17.5 19 7"],
  send: ["M4 12 20 4l-6 16-3-7z", "M11 13 20 4"],
};

export function Icon({ name, className = "size-4" }: { name: keyof typeof ICONS | "alertFill"; className?: string }) {
  if (name === "alertFill") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
        <path d="M12 2.5 1.8 20.5h20.4z" fill="currentColor" />
        <path d="M12 9.5v4.5M12 17.2h.01" stroke="var(--surface)" strokeWidth={2.2} strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const PRIORITY = {
  emergency: { label: "EMERGENCY", className: "bg-emergency-soft text-emergency border border-emergency", icon: "alertFill" },
  high: { label: "High", className: "bg-high-soft text-high", icon: "alert" },
  normal: { label: "Normal", className: "bg-normal-soft text-normal", icon: null },
  low: { label: "Low", className: "bg-low-soft text-low", icon: null },
} as const;

export function PriorityBadge({ priority }: { priority: string }) {
  const p = PRIORITY[priority as keyof typeof PRIORITY] ?? PRIORITY.normal;
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-label font-medium ${p.className}`}>
      {p.icon && <Icon name={p.icon} className="size-3.5" />}
      <span className="sr-only">Priority: </span>
      {p.label}
    </span>
  );
}

export function ReviewBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-review-soft px-2 py-0.5 text-label font-medium text-review">
      <Icon name="person" className="size-3.5" />
      Human review
    </span>
  );
}

const STATUS = {
  open: { label: "Open", dot: "border-2 border-foreground" },
  in_progress: { label: "In progress", dot: "bg-accent" },
  resolved: { label: "Resolved", dot: "bg-ok" },
  cancelled: { label: "Cancelled", dot: "border-2 border-muted line-through" },
} as const;

export function TicketStatus({ status }: { status: string }) {
  const s = STATUS[status as keyof typeof STATUS] ?? STATUS.open;
  return (
    <span className={`inline-flex items-center gap-1.5 text-body-sm ${status === "cancelled" ? "text-muted" : ""}`}>
      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function TicketCard({ ticket }: { ticket: TicketSummary }) {
  const emergency = ticket.priority === "emergency";
  return (
    <article
      className={`space-y-2 rounded-lg border border-border bg-surface p-4 shadow-panel ${
        emergency ? "border-t-[3px] border-t-emergency" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={ticket.priority} />
        {ticket.review && <ReviewBadge />}
        <span className="text-body-sm text-muted">{capitalise(ticket.category)}</span>
      </div>
      <h3 className="text-heading font-semibold">
        {capitalise(ticket.category)}
        {ticket.location ? ` · ${ticket.location}` : ""}
      </h3>
      <p className="line-clamp-2 text-body">{ticket.description}</p>
      {ticket.review && <p className="text-body-sm text-review">{ticket.review}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm text-muted">
        <TicketStatus status={ticket.status} />
        <span>
          <span className="font-mono text-label">#{ticket.id.slice(0, 8)}</span> ·{" "}
          <time dateTime={ticket.createdAt}>{dateFormat.format(new Date(ticket.createdAt))}</time>
        </span>
      </div>
    </article>
  );
}

// Safety guidance is fixed text chosen by code from the ticket's hazards — never written
// by the model. Shown once, under the reply that created an emergency ticket.
const SAFETY: { hazard: string; title: string; steps: string[] }[] = [
  {
    hazard: "gas_smell",
    title: "Leave the property now",
    steps: [
      "Don't use light switches, flames or electrical appliances.",
      "Open doors and windows on your way out if it's safe.",
      "Once outside, call the gas emergency line.",
    ],
  },
  {
    hazard: "electrical_hazard",
    title: "Stay away from the fault",
    steps: [
      "Don't touch the affected socket, switch or appliance.",
      "Switch off at the fuse box only if it's dry and safe to reach.",
    ],
  },
  {
    hazard: "active_water_leak",
    title: "While you wait",
    steps: [
      "Turn off the water at the stopcock if you can.",
      "Keep away from electrics near the water.",
      "Move valuables away from the leak.",
    ],
  },
];

export function safetyGuidanceFor(ticket: TicketSummary) {
  if (ticket.priority !== "emergency") return null;
  return (
    SAFETY.find((s) => ticket.hazards.includes(s.hazard)) ?? {
      hazard: "other",
      title: "While you wait",
      steps: ["Keep away from the affected area until help arrives."],
    }
  );
}

export function EmergencyNotice({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="mt-2 rounded-lg border border-emergency bg-emergency-soft p-3 text-foreground">
      <p className="flex items-center gap-2 text-heading font-semibold">
        <Icon name="alertFill" className="size-4 text-emergency" />
        {title}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-6 text-body">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
    </div>
  );
}
