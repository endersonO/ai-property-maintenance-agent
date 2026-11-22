# PipelineStages

Where a tool call stopped in the executor: validate → authorize → policy → idempotency → execute. Passed stages `status-ok`, the stopping stage in `status-rejected` (dashed, shield) or `status-error` (solid, alert), later stages dashed `muted` "not reached".

Props: `status` `ok | rejected | error`, `stoppedAt` stage name.
