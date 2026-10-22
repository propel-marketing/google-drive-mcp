# Inventory: Campaign Readiness Logic

Track campaign management preconditions and whether partial data blocks users from starting tasks.

Read route handlers/services related to:
- campaign status
- campaign prerequisites
- readiness flags

Write to `{{OUTPUT_PATH}}/inventory/campaign-readiness.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"campaign-readiness"}`
