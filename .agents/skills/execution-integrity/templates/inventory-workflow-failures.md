# Inventory: Workflow Failure Points

Find places where workflows begin, fail, retry, or silently abort in assistant and task workflows.

Emit findings in `{{OUTPUT_PATH}}/inventory/workflow-failures.jsonl`.
End marker:
`{"_summary":true,"status":"complete","count":N,"category":"workflow-failures"}`

Capture:
- 400/5xx response handling
- message/send failure fallbacks
- job handoff breaks
- timeout and cancellation boundaries
