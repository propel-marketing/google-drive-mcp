---
name: execution-integrity-inventory
description: Collect execution integrity inventory evidence for downstream diagnosis
---

## Inventory Phase Objective

Find evidence for runtime integrity in these areas:
- Assistant execution and handoff behavior
- Tool loading and tool-calling contracts
- Workflow/startup failures
- Job queue/task lifecycle behavior and cleanup
- UI control parity and control visibility
- Campaign readiness/deployment gating
- Navigation parity across desktop/mobile
- Notification state and read/clear semantics
- Text rendering spacing and formatting
- Stale job/task detection and pruning
- API pipeline start requests
- Expert contract boundaries

## Instructions

Read all files in:
- `.agents/skills/execution-integrity/reference/current-state.md`
- `.agents/skills/execution-integrity/reference/inventory-criteria.md`
- `.agents/skills/execution-integrity/reference/architecture-reuse.md`

If architecture artifacts are available, first map symbols already covered by architecture findings and mark inventory items as `assumption_source: architecture` only when behavior differs from architecture scope.

Spawn one `trace-scout` for each template listed in `execution-integrity.manifest.json` inventory phase and write outputs under `${OUTPUT_DIR}/inventory/*`.

All inventory templates must produce newline-delimited JSON and finish with a summary line:
`{"_summary":true,"status":"complete","count":N}`
