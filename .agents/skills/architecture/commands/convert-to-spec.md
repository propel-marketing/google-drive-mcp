---
name: architecture:convert-to-spec
description: Converts a completed /architecture audit tree into universal-spec.md. Reads adw-snapshot.yaml for the manifest and violation register, reads reflect-and-map.md for the remediation plan, and produces a spec directly consumable by /task-orchestration convert-to-tasks. Run standalone to regenerate the spec from an existing audit.
argument-hint: "<audit-dir>"
---

# Architecture: Convert to Spec

Standalone spec conversion for an existing `/architecture` audit output. Phase 6 of the architecture skill runs this automatically — invoke this command only when regenerating the spec from an audit that already exists on disk.

---

## Variables

```
$ARGUMENTS: <audit-dir>

audit-dir  — absolute path to the audit output directory
             e.g. ./.agents/runs/architecture/2026-04-26-full-codebase
```

Parse and derive:

```
AUDIT_DIR      — from $ARGUMENTS (required)
SNAPSHOT_PATH  — {AUDIT_DIR}/snapshot/adw-snapshot.yaml
SPEC_PATH      — {AUDIT_DIR}/spec/universal-spec.md
```

Print resolved values before doing anything:

```
AUDIT_DIR:     ./.agents/runs/architecture/2026-04-26-full-codebase
SNAPSHOT_PATH: ~/Desktop/.../snapshot/adw-snapshot.yaml
SPEC_PATH:     ~/Desktop/.../spec/universal-spec.md
```

Verify `{SNAPSHOT_PATH}` exists and ends with `Status: COMPLETE`. If not: stop — `Cannot convert — adw-snapshot.yaml missing or incomplete at {SNAPSHOT_PATH}`

---

## Setup

```bash
mkdir -p "{AUDIT_DIR}/spec"
```

---

## Context Block

Read `{SNAPSHOT_PATH}`. Extract the `manifest.codebase_path` and `manifest.feature_name` fields.

Read:
- `{manifest.codebase_path}/package.json` (or equivalent) → tech stack
- `{manifest.codebase_path}/README.md` if present → what the app does

Format:

```
## System Identity
[What the codebase is, what it does, what FEATURE_NAME is responsible for. 2-3 sentences.]

## Architecture Context
[Tech stack with versions. Key patterns. How layers connect.]

## Constraints
Read-only — never write source files. Only write to {AUDIT_DIR}/spec/universal-spec.md

## Current State
Architecture audit complete across 5 phases. adw-snapshot.yaml contains the full element census,
violation register, and manifest. reflect-and-map.md contains the prioritized remediation plan.
```

---

## Execution

Read `{SNAPSHOT_PATH}`. The `manifest:` section at the top lists every audit output file path.

Construct the agent brief:

```
{Context Block}

## Context for Your Job

You are converting a completed architecture audit into a Universal Spec that task-orchestration can execute.

Read `{SNAPSHOT_PATH}`. It contains a `manifest:` section — use those paths to locate all audit files.

Read these files to build the spec:
- `manifest.plan.reflect_and_map`           — prioritized remediation items (primary source for sections)
- `manifest.plan.principles_audit`          — coverage verdict and FINDING_MISSING items
- `manifest.diagnose.trace`                 — dissolution points and data flow
- `manifest.diagnose.type_dissolution`      — type safety violations with file:line
- `manifest.diagnose.interface_gaps`        — missing interface contracts
- `manifest.diagnose.variable_audit`        — variable naming violations
- `manifest.diagnose.endpoint_drillability` — drillability gaps
- `manifest.diagnose.responsibility_scatter`— scattered responsibility
- `manifest.diagnose.dead_code`             — dead exports and stubs
- `manifest.diagnose.grep_test`             — naming coherence failures

Read the output format template at: `manifest.references.universal_spec_format`
Read the quality bar at: `manifest.references.final_spec_example`

Produce `{SPEC_PATH}` using the universal-spec-format.md template exactly.

Mapping rules:
- Every CRITICAL and MAJOR violation from reflect-and-map becomes a spec section
- Each section maps to ≤3 manifest rows (split if a remediation item touches more files)
- Phase assignment follows the remediation plan's execution order — CRITICAL items are Phase 1
- Acceptance criteria must be grep-verifiable or compile-verifiable — no prose conditions
- Every work item must name exact file path, exact function/symbol, exact operation

Quality gate before writing:
- [ ] Every CRITICAL item from principles-audit is a Phase 1 section with zero dependencies
- [ ] Every section has a layer label: schema|service|route|component|hook|config|test|infra|contract
- [ ] No section has >3 manifest rows
- [ ] Phase 1 sections have no depends-on entries
- [ ] §5 Constraints is populated from adw-snapshot.yaml violations + principles-audit hard constraints

Write output to: {SPEC_PATH}
End with: Status: COMPLETE
```

Spawn one `auditor` agent with this brief. Wait for completion.

Read the last line of `{SPEC_PATH}`. Confirm it is `Status: COMPLETE`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

```
Convert to Spec complete

Audit:  {AUDIT_DIR}
Spec:   {SPEC_PATH}

Sections: N
  Phase 1 (CRITICAL): N
  Phase 2: N
  Phase 3+: N

Manifest rows: N files touched

Next:
  /task-orchestration convert-to-tasks {plan-name}
  (spec lives at {SPEC_PATH})
```
