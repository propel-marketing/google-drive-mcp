# Enrich Issues — Execution Integrity

Read `issues/issues.jsonl`.

For each issue add:
- confidence
- impact
- owner_hint
- test_hint
- rollout_risk

Write to `{{OUTPUT_PATH}}/issues/issues-enriched.jsonl`.
Summary line:
`{"_summary":true,"status":"complete","count":N,"category":"issues-enriched"}`
