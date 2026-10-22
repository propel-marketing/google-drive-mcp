# Diagnose: Task Lifecycle

Find failure modes in task/job lifecycle:
- create -> running -> completed/failed
- retry/rollback
- stale cleanup

Write to `{{OUTPUT_PATH}}/diagnose/task-lifecycle.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"task-lifecycle"}`
