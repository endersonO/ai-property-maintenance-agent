# Button

Triggers an action. **Primary** (`accent` fill, `accent-text` label) at most once per view — "Send" in the composer, "Approve" in review. **Secondary** (`surface` + `border-strong`) for everything else ("Switch tenant", "Retry run"). Ghost for toolbar actions.

Props: `variant` `primary | secondary | ghost`, `size` `md | sm`, `icon` (icon name), `pending` + `pendingLabel` (shows spinner, sets `aria-busy`, disables), plus native button props. `forceState` is for documentation only.

- Labels are verbs in sentence case: "Send", "Switch tenant", "Open trace".
- Pending keeps the button width stable and changes the verb ("Sending…"); never remove the button.
- Error state: retry affordance after a failed action, `status-error` text on `status-error-soft` with the alert icon.
- Focus-visible: 2px `accent` ring, 2px offset.
