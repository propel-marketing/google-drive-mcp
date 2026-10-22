---
name: execution-integrity-synthesize
description: Synthesize execution findings into prioritized fixes and roadmap material
---

## Synthesis Phase Objective

Read diagnose outputs from `${OUTPUT_DIR}/diagnose` and emit:
- runtime integrity synthesis
- assistant tool orchestration synthesis
- UI reliability synthesis
- job lifecycle synthesis
- issue set and enrichment
- principles audit
- ecosystem handoff JSON

Apply reuse policy:
- If architecture already covers the same symbol/path and no runtime delta is observed, avoid duplicate recommendations.
- For findings that extend architecture scope, include `architecture_overlap` and `execution_only_delta` fields for traceability.

## Instructions

Spawn `synthesizer` agents for plan tasks in the manifest:
- `synthesize-runtime.md`
- `synthesize-ai-orchestration.md`
- `synthesize-ui-reliability.md`
- `synthesize-job-lifecycle.md`
- `ecosystem-handoff.json`
- `assemble-issues.md`
- `enrich-issues.md`
- `principles-audit.md`

All `.md` outputs should end with:
`Status: COMPLETE`

JSONL issue outputs must end with:
`{"_summary":true,"status":"complete","count":N}`
