# Inventory: Stale Jobs and Stuck Work

Find where background jobs or long-polling states become stale and remain visible as loading.

Write to `{{OUTPUT_PATH}}/inventory/staleness.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"staleness"}`

Flag:
- no timeout on running states
- no retry cap
- never-done cleanup hooks
