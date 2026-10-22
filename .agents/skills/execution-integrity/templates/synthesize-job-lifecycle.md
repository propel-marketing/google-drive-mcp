# Synthesis: Job Lifecycle

Use diagnose evidence from:
- `diagnose/task-lifecycle.jsonl`
- `diagnose/staleness` (if available)
- `diagnose/workflow-failure` (if available)

Output recommendations into `{{OUTPUT_PATH}}/plan/synthesis-job-lifecycle.md`:
- timeout and stale cleanup rules
- retry caps
- idempotency and lock/lease handling
- observability and incident trail

End with `Status: COMPLETE`.
