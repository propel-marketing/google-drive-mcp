# Architecture Reuse Strategy

Execution-integrity should start from prior architecture outputs when they exist and avoid duplicate evidence collection.

Scope:
- Reuse only for design/structure findings already validated by architecture.
- Do not reuse architecture for behavior-only items (runtime timing, retry policy, tool-call loops, job cleanup).

Source mapping:
- `.agents/runs/architecture/<run>/plan/synthesis-*.md` (design findings and architectural intent)
- `.agents/runs/architecture/<run>/issues/issues-enriched.jsonl` (existing critical/major issue IDs)
- `.agents/contracts/architecture.manifest.json` when task IDs are needed for traceability

Reuse policy:
- If an identical symbol + symptom already has an Architecture finding, log `assumption_source: architecture` and reference that issue ID.
- If architecture misses runtime dimensions (timing, retries, live state transitions, UI event timing), create a fresh execution finding even when symbol overlaps.
- If architecture and execution evidence conflict, execution findings become the authoritative source for this skill and note conflict explicitly.
