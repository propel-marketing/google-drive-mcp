---
name: reflect-and-map
description: Apply ADW principles to the snapshot + diagnose outputs to produce the gap analysis and prioritized remediation plan
argument-hint: "<codebase-path> [feature-name] [audit-dir]"
---

# Reflect and Map

Translates the consolidated `adw-snapshot.yaml` and the 4 diagnose outputs (trace, responsibility-scatter-audit, dead-code, grep-test) into a domain-model-aware gap analysis: entry-point coverage, naming map, type-safety gaps, observability gaps, enum consolidation, interface/class gaps, folder-structure changes, and a prioritized remediation plan. Output feeds `/architecture/principles-audit`.

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
CODEBASE_PATH         — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME          — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME         — last path segment of CODEBASE_PATH
FEATURE_SLUG          — feature-name lowercased and hyphenated
AUDIT_DIR             — from $ARGUMENTS (third token); default:
                        ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}
SNAPSHOT_PATH         — {AUDIT_DIR}/snapshot/adw-snapshot.yaml
DIAGNOSE_TRACE        — {AUDIT_DIR}/diagnose/trace.jsonl
DIAGNOSE_SCATTER      — {AUDIT_DIR}/diagnose/responsibility-scatter-audit.jsonl
DIAGNOSE_DEAD_CODE    — {AUDIT_DIR}/diagnose/dead-code.jsonl
DIAGNOSE_GREP_TEST    — {AUDIT_DIR}/diagnose/grep-test.jsonl
OUTPUT_PATH           — {AUDIT_DIR}/plan/reflect-and-map.md
```

Print resolved values before doing anything:

```
CODEBASE_PATH:   /abs/path/to/project
FEATURE_NAME:    foundation
CODEBASE_NAME:   Propel-ADW
AUDIT_DIR:       ./.agents/runs/architecture/2025-01-15-foundation
SNAPSHOT_PATH:   {AUDIT_DIR}/snapshot/adw-snapshot.yaml
DIAGNOSE_FILES:  trace.jsonl · responsibility-scatter-audit.jsonl · dead-code.jsonl · grep-test.jsonl
OUTPUT_PATH:     {AUDIT_DIR}/plan/reflect-and-map.md
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If AUDIT_DIR does not exist, stop: `Cannot run — audit directory not found: {AUDIT_DIR}`

Verify the snapshot exists and ends with `Status: COMPLETE`. Verify all 4 diagnose files exist and each has a last non-empty line that parses as JSON with `"_summary":true` and `"status":"complete"`. If any is missing or incomplete, stop with `Cannot run — input file {path} is missing or incomplete`.

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
[Read-only — never write source files. Only write to OUTPUT_PATH. Do not re-read source — the snapshot and diagnose files are ground truth.]

## Current State
[Snapshot at SNAPSHOT_PATH plus 4 diagnose outputs are the inputs. This pass produces the remediation plan.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/reflect-and-map.md`.

Substitute:
```
{{CODEBASE_PATH}}         → {CODEBASE_PATH}
{{FEATURE_NAME}}          → {FEATURE_NAME}
{{OUTPUT_PATH}}           → {OUTPUT_PATH}
{{EMBEDDED_REFERENCE}}    → Read these ADW reference files before beginning:
                            - ./.agents/skills/architecture/reference/01-principle.md
                            - ./.agents/skills/architecture/reference/02-building-blocks.md
                            - ./.agents/skills/architecture/reference/03-observability.md
                            - ./.agents/skills/architecture/reference/05-construction.md
{{INVENTORY_YAML_PATH}}   → {SNAPSHOT_PATH}
{{DIAGNOSE_FILES}}        → bullet list of the 4 absolute paths:
                            - {DIAGNOSE_TRACE}
                            - {DIAGNOSE_SCATTER}
                            - {DIAGNOSE_DEAD_CODE}
                            - {DIAGNOSE_GREP_TEST}
```

Verify `{SNAPSHOT_PATH}` ends with `Status: COMPLETE`. For the 4 diagnose JSONL paths, verify each exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"`. If any is incomplete, stop with the offending path.

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Confirm it is `Status: COMPLETE`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Reflect and Map complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

[paste the entire "## Audit Summary" section verbatim from {OUTPUT_PATH}]

Next:
  /architecture/principles-audit {CODEBASE_PATH} {FEATURE_NAME}
```
