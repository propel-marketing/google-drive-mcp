# Diagnose: Expert Delegation

Diagnose where expert/tool delegation loses context, misroutes due to missing skill metadata, or calls generic handlers too early.

Read inventory outputs:
- `inventory/tool-load-path.jsonl`
- `inventory/expert-contract.jsonl`

Write findings to `{{OUTPUT_PATH}}/diagnose/expert-delegation.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"expert-delegation"}`
