# Inventory: Assistant Runtime

Read assistant runtime and orchestration surfaces:
- `src/server`
- `src/services/ai-assistant`
- `src/services/ai-assistant/tools`
- `src/services/ai-assistant/workflows`

Goal: list where assistant responses, tasking, and model/tool handoff logic is selected and executed.

Emit newline-delimited JSON objects to `{{OUTPUT_PATH}}/inventory/assistant-runtime.jsonl` and end with:
`{"_summary":true,"status":"complete","count":N,"category":"assistant-runtime"}`

Each object should include:
- `id`
- `location` as `file:line`
- `finding`
- `severity`
- `impact`
- `evidence`
- `suggested_fix`
