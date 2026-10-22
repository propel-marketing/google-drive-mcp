---
name: execution-integrity-convert-to-spec
description: Convert synthesis outputs into a task-ready universal spec
---

## Spec Conversion Objective

Use outputs from `${OUTPUT_DIR}/plan` and `${OUTPUT_DIR}/issues` to produce:
- `${OUTPUT_DIR}/spec/universal-spec.md`

## Instructions

Use `synthesizer` role and read:
- `.agents/skills/execution-integrity/reference/spec-output-format.md`
- `.agents/skills/execution-integrity/reference/synthesis-format.md`
- `.agents/skills/execution-integrity/reference/issue-prioritization.md`

Include:
- objective
- scope
- failure chains by severity
- required behavior tests
- rollout and validation
- file-level change assumptions

Finish with:
`Status: COMPLETE`
