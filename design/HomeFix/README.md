HomeFix is a portfolio prototype of an AI maintenance assistant for residential lettings. Tenants report problems in a chat; the assistant gathers context and *proposes* actions; deterministic software decides priority, cost and escalation; a human approves risky cases. Engineers inspect every run step by step. All data is fictional.

The system has two registers on one set of tokens: a **calm, roomy tenant register** and a **dense, precise operator register**. Same colours, same type families — different density and voice.

## Content fundamentals

**Locale.** UK English (*colour, organise, cancelled*), £ for money (`£0.0041`, `£180.00`), en-GB dates (`22 Nov 2026, 08:14`; relative only under a minute: “just now”). 24-hour time.

**Tenant voice** — plain, calm, specific. Short sentences. Say what happens next and when.
- Do: “I've logged this as an emergency. A contractor will call you within 2 hours.”
- Do: “If you smell gas, leave the property and call the gas emergency line on 0800 000 0000 (fictional).”
- Don't: “Uh-oh!”, “Don't worry!”, exclamation marks, jargon (*idempotency, policy v3*), blame.
- The assistant speaks as “I”, the tenant is “you”. The agency is named (“Harbourline Lettings”), never “the system”.
- Failures are honest and say what was kept: “I couldn't finish my reply, but your request was recorded.”

**Operator voice** — terse, literal, scannable. Nouns and values, not sentences. IDs and tool names in mono, verbatim (`create_ticket`, `run_7f3a2c`). Status words are fixed: *completed, failed, ok, rejected, error*.

**Casing.** Sentence case everywhere (“Switch tenant”, “Your tickets”). Badges may set in caps via the `label` style only. No emoji anywhere.

## Visual foundations

**Colour.** Neutral, slightly green-grey canvas; one petrol-teal `accent` for action and the tenant's own voice. Semantic colours carry meaning only — never decoration.
- Page on `background`; panels on `surface` with a `border` hairline and `shadow-sm`; recessed areas (JSON, table heads) on `subtle`.
- Text: `foreground` for content, `muted` for meta. Both read at ≥ 4.5:1 on `background`, `surface` and `subtle` in both themes.
- Primary actions: `accent` fill, `accent-text` label, `accent-hover` on hover. One primary per view.
- Semantic badges pair `<token>` text with `<token>-soft` background (≥ 4.5:1 in both themes) **and always a word**; colour is never the only signal.

**Emergencies** must be unmistakable, not alarmist: `priority-emergency` badge with the alert icon and the word “Emergency”, a `border-edge` top edge on the ticket card, and a single `priority-emergency-soft` notice in the chat with the next step. No pulsing, no red page, no full-bleed banners.

**Rejected vs error.** *Rejected* = the system correctly said no (a guardrail held) → `status-rejected` ochre, **shield icon, dashed outline**, word “Rejected”. *Error* = something broke → `status-error` red, **filled alert icon, solid outline**, word “Error”. They differ in hue, icon shape and line style, so they remain distinct in greyscale.

**Human review** uses `review` (violet) with the person icon and the words “Human review”. On a ticket it is a badge plus a one-line reason (“Over £500 — needs agency approval”).

**Type.** Geist for UI, Geist Mono for IDs, JSON and numbers. Tenant messages in `body-lg` (16px); operator tables in `body-sm` / `mono-sm` with tabular figures. Titles `title-lg` / `title`, headings `heading`, badges `label`.

**Spacing & density.** 4px base. Tenant surfaces use `space-4`–`space-6` padding; operator surfaces `space-2`–`space-3`. Desktop panel gap `space-6`.

**Radii.** `radius-md` controls, `radius-lg` panels and cards, `radius-xl` chat bubbles with the corner nearest the speaker at `radius-sm`, `radius-sm` badges and code.

**Borders & elevation.** Borders do the work; shadows are minimal. Control borders use `border-strong` (3:1). Only `shadow-sm` at rest; `shadow-md` for floating layers.

**States.** Hover: one step darker fill or `subtle` background. Focus-visible: 2px solid `accent` ring, 2px offset (3:1 on every surface). Disabled: 50% opacity + `not-allowed`, never colour change alone. Pending: inline spinner + verb in progress (“Sending…”), control disabled. Error: `status-error` border + message below, linked with `aria-describedby`.

**Motion.** Only the spinner and the three-dot “working” indicator move; both stop under `prefers-reduced-motion` (dots become static “Working…”).

**Layout.** Tenant portal: chat ~60% / tickets ~40% side by side ≥ 960px; stacked below (chat first). Works from 360px. Inspector is desktop-first: runs table above, detail with timeline (left) and context panel (right).

## Accessibility

- Every chat bubble has visually hidden speaker text: “You:” / “Assistant:”.
- The conversation log is `role="log"` with `aria-live="polite"`; new assistant replies are announced once. The pending state announces “Assistant is working”.
- Composer: Enter sends, Shift+Enter inserts a new line, explicit Send button; the shortcut hint is visible text.
- Badges and statuses always include a word; icons are `aria-hidden`.
- Light and dark follow the system preference (`color-scheme: light dark`); no toggle.

## Iconography

A small inline-SVG set drawn in the bundle (24px grid, 1.75 stroke, round caps, `currentColor`): alert, shield, person, check, x, clock, tool, cpu, chevron, send. No icon font, no emoji. The product name is set in plain type — HomeFix has no logo.

## Using this system

Components are in `components/bundle.js` as `window.HomeFix` (React 18). Styles are in `components/bundle.css` with the `lo-` prefix. The Next.js 16 + Tailwind CSS 4 token mapping (`light-dark()` and `@theme`) is in the **Implementation** section.
