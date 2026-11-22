# ChatBubble

One message in the conversation.

Props: `role` `tenant | assistant`, `state` `sent | pending | failed`, `time` (en-GB, 24h), `after` (a node rendered under the bubble, e.g. EmergencyNotice), children = message text (pre-wrapped).

- **Tenant**: right-aligned, `accent` fill, `accent-text`.
- **Assistant**: left-aligned, `subtle` fill, `foreground` text.
- **Pending**: three-dot indicator + "Assistant is working…" (static under reduced motion).
- **Failed**: `surface` with `status-error` outline and "Reply not finished" heading; the body must say what *was* saved.
- Every bubble starts with visually hidden "You:" / "Assistant:". Text is `body-lg` (16px).
