---
name: execution-integrity-diagnose
description: Convert execution inventory into concrete failure chains and user-impact risks
---

## Diagnose Phase Objective

Read all completed inventory outputs from `${OUTPUT_DIR}/inventory` and convert observations into:
- Reproducible failure chains
- Missing-state/cleanup chains
- Handoff or orchestration integrity risks
- UI/UX reliability regressions
- Campaign readiness blockers
- Expert/tooling delegation risks
- Rendering format regressions (list spacing, headings, markdown output)

## Instructions

Use one `diagnose-auditor` agent per diagnose template in `execution-integrity.manifest.json`.

Read on:
- `.agents/skills/execution-integrity/reference/current-state.md`
- `.agents/skills/execution-integrity/reference/diagnose-patterns.md`
- `.agents/skills/execution-integrity/reference/architecture-reuse.md`

Before adding new failure chains, cross-link with architecture issue IDs when the same symbol exists there, and only add fresh findings when architecture lacked runtime/sequence evidence.

Write outputs under `${OUTPUT_DIR}/diagnose/*` as JSONL.
Every file must end with:
`{"_summary":true,"status":"complete","count":N}`
