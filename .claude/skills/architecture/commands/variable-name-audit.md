---
name: variable-name-audit
description: Audit parameter and local variable names in the three most-central files of a feature; flag generic names that fail the grep test
argument-hint: "<codebase-path> [feature-name] [map-path]"
---

# Variable Name Audit

Reads the structure/map inventory and audits parameter and local variable names in the three most-central files of the feature. Flags generic names (`data`, `res`, `result`, `r`, `pd`, ...) that hide what a variable actually holds and break the grep test, then proposes domain-specific rename targets. Output feeds `/architecture/reflect-and-map`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [map-path]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
map-path       — absolute path to the structure/map inventory output (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
                 e.g. /Users/vilovieta/Projects/Propel-ADW → Propel-ADW
FEATURE_SLUG   — feature-name lowercased and hyphenated
MAP_PATH       — from $ARGUMENTS (third token); default:
                 ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/inventory/structure.jsonl
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/diagnose/variable-name-audit.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
MAP_PATH:      ./.agents/runs/architecture/2025-01-15-foundation/inventory/structure.jsonl
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/diagnose/variable-name-audit.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If MAP_PATH does not exist, stop: `Cannot run — prior map not found: {MAP_PATH}`

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
[Read-only — never write source files. Only write to OUTPUT_PATH.]

## Current State
[Prior structure/map inventory at MAP_PATH is the input.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/diagnose-variable-audit.md`.

Substitute:
```
{{CODEBASE_PATH}}  → {CODEBASE_PATH}
{{FEATURE_NAME}}   → {FEATURE_NAME}
{{CODEBASE_NAME}}  → {CODEBASE_NAME}
{{OUTPUT_PATH}}    → {OUTPUT_PATH}
{{PRIOR_FILE_1}}   → {MAP_PATH}
```

Verify `{MAP_PATH}` exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"` before spawning the agent. If not, stop with `Cannot run — prior map at {MAP_PATH} is incomplete`.

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Variable Name Audit complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Files audited: 3 | Generic names found: N | Top rename targets: {top 3}

Next:
  /architecture/reflect-and-map {CODEBASE_PATH} {FEATURE_NAME}
```
