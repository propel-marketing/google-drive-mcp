# Synthesis: Runtime Reliability

Read these diagnose files:
- `diagnose/failure-chains.jsonl`
- `diagnose/task-lifecycle.jsonl`
- `diagnose/expert-delegation.jsonl`
- `diagnose/ui-parity.jsonl`

Write prioritized runtime integrity recommendations to `{{OUTPUT_PATH}}/plan/synthesis-runtime.md`.
Use severity labels and file-scoped acceptance criteria.

Prefer evidence reuse from architecture and prior workflow outputs where available:
- if the same symbol already has an architecture finding, include that ID as context.
- avoid duplicating duplicate diagnosis language; make this report execution-fidelity focused.
- Add `architecture_overlap` (boolean) and `execution_only_delta` for each recommendation:
  - `architecture_overlap`: true when the symbol/path appears in architecture.
  - `execution_only_delta`: concrete runtime difference observed (timing, sequencing, lifecycle, handoff, visibility).

End with:
`Status: COMPLETE`
