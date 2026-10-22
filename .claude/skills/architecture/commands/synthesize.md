---
name: synthesize
description: Consolidate all inventory outputs into a single structured adw-snapshot.yaml census of every architectural element
argument-hint: "<codebase-path> [feature-name] [inventory-dir]"
---

# Synthesize Inventory

Reads all parallel inventory outputs (enums, classes, structure, schema, types, interfaces, entry-points, observability, folder-structure, and any others present) and consolidates them into a single machine-readable `adw-snapshot.yaml`. Sorts every list alphabetically by name for stable diffs. The snapshot is the ground-truth census consumed by `/architecture/reflect-and-map`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [inventory-dir]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
inventory-dir  — absolute path to the directory containing the 8 inventory files (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
FEATURE_SLUG   — feature-name lowercased and hyphenated
INVENTORY_DIR  — from $ARGUMENTS (third token); default:
                 ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/inventory
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/snapshot/adw-snapshot.yaml
```

The inventory files are:
```
{INVENTORY_DIR}/enums.jsonl
{INVENTORY_DIR}/classes.jsonl
{INVENTORY_DIR}/structure.jsonl
{INVENTORY_DIR}/schema.jsonl
{INVENTORY_DIR}/types.jsonl
{INVENTORY_DIR}/interfaces.jsonl
{INVENTORY_DIR}/entry-points.jsonl
{INVENTORY_DIR}/observability.jsonl
{INVENTORY_DIR}/folder-structure.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
INVENTORY_DIR: ./.agents/runs/architecture/2025-01-15-foundation/inventory
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/snapshot/adw-snapshot.yaml
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If INVENTORY_DIR does not exist, stop: `Cannot run — inventory directory not found: {INVENTORY_DIR}`

For each of the inventory files: verify the file exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"`. If any is missing or incomplete, stop with `Cannot run — inventory file {path} is missing or incomplete` and list every offending path.

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
[Read-only — never write source files. Only write to OUTPUT_PATH. Do not grep source — the 8 inventory files are the only ground truth.]

## Current State
[8 inventory files complete in INVENTORY_DIR. This pass consolidates them — no new analysis.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/synthesize-inventory.md`.

Substitute:
```
{{CODEBASE_PATH}}        → {CODEBASE_PATH}
{{FEATURE_NAME}}         → {FEATURE_NAME}
{{OUTPUT_PATH}}          → {OUTPUT_PATH}
{{ISO_TIMESTAMP}}        → current ISO 8601 timestamp
{{EMBEDDED_REFERENCE}}   → Read these ADW reference files before beginning:
                           - ./.agents/skills/architecture/reference/01-principle.md
                           - ./.agents/skills/architecture/reference/02-building-blocks.md
{{INVENTORY_FILES}}      → bullet list of the absolute paths:
                           - {INVENTORY_DIR}/enums.jsonl
                           - {INVENTORY_DIR}/classes.jsonl
                           - {INVENTORY_DIR}/structure.jsonl
                           - {INVENTORY_DIR}/schema.jsonl
                           - {INVENTORY_DIR}/types.jsonl
                           - {INVENTORY_DIR}/interfaces.jsonl
                           - {INVENTORY_DIR}/entry-points.jsonl
                           - {INVENTORY_DIR}/observability.jsonl
                           - {INVENTORY_DIR}/folder-structure.jsonl
```

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Confirm it is `Status: COMPLETE`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Synthesize Inventory complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Entry points: N | Enums: N | Schemas: N | Types: N | Interfaces: N | Classes: N | Structures: N | Violations: N CRITICAL · N MAJOR · N MINOR

Next:
  /architecture/reflect-and-map {CODEBASE_PATH} {FEATURE_NAME}
```
