# Inventory: Campaign Refresh Behavior

Find any timers, polling, or forced refresh loops in Campaign screens and project management surfaces.

Emit results to `{{OUTPUT_PATH}}/inventory/campaign-refresh.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"campaign-refresh"}`

Flag:
- high-frequency auto refresh
- stale interval config
- race conditions between mutation and background polling
