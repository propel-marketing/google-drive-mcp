# Assemble Issues — Execution Integrity

Read:
- `plan/synthesis-runtime.md`
- `plan/synthesis-ai-orchestration.md`
- `plan/synthesis-ui-reliability.md`
- `plan/synthesis-job-lifecycle.md`

Write issue JSONL records to `{{OUTPUT_PATH}}/issues/issues.jsonl` with fields:
- `id`
- `title`
- `severity`
- `area`
- `finding`
- `files`
- `acceptance_criteria`

End with:
`{"_summary":true,"status":"complete","count":N,"category":"issues"}`
