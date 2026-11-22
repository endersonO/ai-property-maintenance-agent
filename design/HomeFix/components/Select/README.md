# Select

Native `<select>` with a visible label, styled with `border-strong` on `surface`. Use for the simulated tenant picker and inspector filters (workflow, source, status).

Props: `label` (required; `hideLabel` keeps it for screen readers only), `options` (strings or `{value,label}`), `hint`, `error`, `pending`, `disabled`, native select props. Hint/error are linked via `aria-describedby`; error sets `aria-invalid`.

- Keep native: it gives keyboard and mobile pickers for free.
- Error text says what happened and what to do, in `status-error` with the alert icon.
