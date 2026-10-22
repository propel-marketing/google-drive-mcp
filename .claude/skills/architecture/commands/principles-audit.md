---
name: principles-audit
description: Audit the audit — verify every ADW principle was checked, every finding captured, every violation addressed in the remediation plan
argument-hint: "<codebase-path> [feature-name] [audit-dir]"
---

# ADW Principles Holistic Audit

Final checkpoint before spec generation. Reads every ADW reference file and verifies, against the snapshot + 4 diagnose outputs + reflect-and-map, that every principle was checked, every finding captured, and every violation translated into a remediation item. Flags GAPs (principle never audited), PARTIALs (finding not fully translated), FINDING_MISSINGs (violation not in plan), and vague remediation items. Output feeds `/architecture/convert-to-spec`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [audit-dir]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
audit-dir      — absolute path to the audit run root (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH          — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME           — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME          — last path segment of CODEBASE_PATH
FEATURE_SLUG           — feature-name lowercased and hyphenated
AUDIT_DIR              — from $ARGUMENTS (third token); default:
                         ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}
SNAPSHOT_PATH          — {AUDIT_DIR}/snapshot/adw-snapshot.yaml
DIAGNOSE_TRACE         — {AUDIT_DIR}/diagnose/trace.jsonl
DIAGNOSE_SCATTER       — {AUDIT_DIR}/diagnose/responsibility-scatter-audit.jsonl
DIAGNOSE_DEAD_CODE     — {AUDIT_DIR}/diagnose/dead-code.jsonl
DIAGNOSE_GREP_TEST     — {AUDIT_DIR}/diagnose/grep-test.jsonl
REFLECT_AND_MAP_PATH   — {AUDIT_DIR}/plan/reflect-and-map.md
OUTPUT_PATH            — {AUDIT_DIR}/plan/principles-audit.md
```

Print resolved values before doing anything:

```
CODEBASE_PATH:        /abs/path/to/project
FEATURE_NAME:         foundation
CODEBASE_NAME:        Propel-ADW
AUDIT_DIR:            ./.agents/runs/architecture/2025-01-15-foundation
SNAPSHOT_PATH:        {AUDIT_DIR}/snapshot/adw-snapshot.yaml
DIAGNOSE_FILES:       trace.jsonl · responsibility-scatter-audit.jsonl · dead-code.jsonl · grep-test.jsonl
REFLECT_AND_MAP_PATH: {AUDIT_DIR}/plan/reflect-and-map.md
OUTPUT_PATH:          {AUDIT_DIR}/plan/principles-audit.md
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If AUDIT_DIR does not exist, stop: `Cannot run — audit directory not found: {AUDIT_DIR}`

Verify the snapshot and the reflect-and-map output each end with `Status: COMPLETE`. Verify all 4 diagnose files exist and each has a last non-empty line that parses as JSON with `"_summary":true` and `"status":"complete"`. If any is missing or incomplete, stop with `Cannot run — input file {path} is missing or incomplete`.

---

## Setup

```bash
mkdir -p "$(dirname {OUTPUT_PATH})"
```

---

## Context Block

Read the codebase to build project context. Prepend this block to the agent brief.

Read:
- `{CODEBASE_PATH}/package.json` (or equivalent) → tech stack, dependencies
- `{CODEBASE_PATH}/README.md` if present → what the app does
- `{CODEBASE_PATH}/src` directory listing → folder structure overview

Format:

```
## System Identity
[What CODEBASE_NAME is, what it does, who uses it, what FEATURE_NAME is responsible for. 2-3 sentences.]

## Architecture Context
[Tech stack with versions. Key patterns. How layers connect.]

## Constraints
[Read-only — never write source files. Only write to OUTPUT_PATH. Do not re-read source. Audit the audit, not the code.]

## Current State
[Snapshot, 4 diagnose outputs, and reflect-and-map plan are the inputs. This pass verifies coverage against ADW reference files.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/adw-principles-audit.md`.

Substitute:
```
{{CODEBASE_PATH}}            → {CODEBASE_PATH}
{{FEATURE_NAME}}             → {FEATURE_NAME}
{{OUTPUT_PATH}}              → {OUTPUT_PATH}
{{EMBEDDED_REFERENCE}}       → Read these ADW reference files before beginning:
                               - ./.agents/skills/architecture/reference/01-principle.md
                               - ./.agents/skills/architecture/reference/02-building-blocks.md
                               - ./.agents/skills/architecture/reference/03-observability.md
                               - ./.agents/skills/architecture/reference/04-diagnostics.md
                               - ./.agents/skills/architecture/reference/05-construction.md
{{SNAPSHOT_PATH}}            → {SNAPSHOT_PATH}
{{DIAGNOSE_FILES}}           → bullet list of the 4 absolute paths:
                               - {DIAGNOSE_TRACE}
                               - {DIAGNOSE_SCATTER}
                               - {DIAGNOSE_DEAD_CODE}
                               - {DIAGNOSE_GREP_TEST}
{{REFLECT_AND_MAP_PATH}}     → {REFLECT_AND_MAP_PATH}
```

Verify `{SNAPSHOT_PATH}` and `{REFLECT_AND_MAP_PATH}` each end with `Status: COMPLETE`. For the 4 diagnose JSONL paths, verify each exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"`. If any is incomplete, stop with the offending path.

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Confirm it is `Status: COMPLETE`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
ADW Principles Holistic Audit complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

[paste the entire "## ADW Principles Holistic Audit — Final Verdict" section verbatim from {OUTPUT_PATH}]

Next:
  /architecture/convert-to-spec {AUDIT_DIR}
```
