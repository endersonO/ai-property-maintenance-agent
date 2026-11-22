# TimelineEvent

One event in a run's vertical timeline, as a disclosure (`<details>`). Rejected and error events open by default.

Props: `event` — model call `{ step, kind: 'model', model, ms, tokens, requested: [tool] }` or tool call `{ step, kind: 'tool', tool, status: ok|rejected|error, stoppedAt, reason, ms, args, result, ticket?: {id, priority, policy} }`.

- Node: `accent` CPU for model calls; check / dashed shield / filled alert for tool outcomes.
- Card outline matches outcome: none, dashed ochre, solid red.
- Metrics (duration, tokens) right-aligned in `mono-sm`.
