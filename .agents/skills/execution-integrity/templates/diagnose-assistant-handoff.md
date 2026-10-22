# Diagnose: Assistant Handoff

Diagnose gaps in assistant handoff and routing:
- model selection
- tool selection and validation
- output parser boundaries

Read `diagnose-failure-chains.jsonl` and related inventory files.

Write results to `{{OUTPUT_PATH}}/diagnose/assistant-handoff.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"assistant-handoff"}`
