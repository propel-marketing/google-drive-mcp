# Inventory: Task & Job Lifecycle

Inspect task queues, background jobs, and INNGEST/Ingest workers for execution state transitions.

Read:
- job state columns / enums
- queue dispatch handlers
- cleanup/retry paths

Write JSONL to `{{OUTPUT_PATH}}/inventory/task-jobs.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"task-jobs"}`
