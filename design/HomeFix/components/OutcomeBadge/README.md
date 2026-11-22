# OutcomeBadge

Outcome of a tool call (`ok | rejected | error`) or a run (`completed | failed`).

- **Rejected** — the system correctly said no. Ochre `status-rejected`, shield icon, **dashed** outline.
- **Error** — something broke. Red `status-error`, filled alert icon, **solid** outline.
- They differ in hue, icon and line style, so they stay distinct in greyscale and for colour-blind users. Never show "rejected" in red.
