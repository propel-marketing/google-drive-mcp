# Execution Integrity — Current State

This skill is for runtime behavior, orchestration, and execution reliability gaps that are frequently missed by structure-only audits.

Current issue patterns to prioritize:
- FILES label, filter surface, and control copy mismatches (desktop/mobile divergence, dropdown consistency).
- Workflow start failures and partial execution in modal/pipeline entry points.
- AI assistant model-control complexity when behavior can be defaulted to a stable mode.
- Dropdown implementation divergence from custom control standards across assistant and workflow screens.
- Notification clear-state behavior that can’t be reliably dismissed.
- Stale jobs/states left in loading with no purge or timeout.
- Content/on-page pipeline failures at API start boundaries.
- Mobile sidebar shape and icon grammar mismatches with desktop flow.
- Proactive mode deploys with immediate handoff drop-off.
- Campaign manager gating that blocks partial-data usage and masks readiness.
- Aggressive background refresh loops that disrupt UX and editing.
- AI tool/skill routing without full schema-aware handoff.
- Assistant stream/task failures masked by generic error paths.
- Expert invocation behavior (tool awareness, schema inspection, delegation fallback rules).
- Markdown/list formatting spacing regressions in numbered and bold list output.
- Weak task plan and assistant thought orchestration that escalates into failure loops.

Execution-integrity tracks these as runtime integrity risks unless architecture already proves the same path at design level.

Outputs are organized by:
- `inventory/` — raw evidence
- `diagnose/` — failure chain synthesis
- `plan/` — prioritized remediation strategy
- `issues/` — task-ready issue records
- `spec/` — execution-integrity universal spec
