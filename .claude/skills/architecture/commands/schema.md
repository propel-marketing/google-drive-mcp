---
name: architecture-schema
description: Inventory every runtime schema and validator, identify schemas defined but never called, and flag entry points missing schemas.
argument-hint: "<codebase-path> [feature-name]"
---

# Architecture — Schema Inventory

Catalog every runtime schema (Zod or equivalent) in the target codebase: where it is defined, where it is called, whether its TypeScript type is derived via `z.infer` or declared separately (drift risk), and which entry points have no schema at all. Produces a complete schema inventory at `inventory/schema.jsonl` that the type-dissolution-check command consumes to identify drift between compile-time types and runtime validation.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
               e.g. /Users/vilovieta/Projects/Propel-ADW → Propel-ADW
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/inventory/schema.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/inventory/schema.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`

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
[Prior findings if any. "No prior audit" if first run.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/inventory-schemas.md`.

Substitute:
```
{{CODEBASE_PATH}} → {CODEBASE_PATH}
{{FEATURE_NAME}}  → {FEATURE_NAME}
{{OUTPUT_PATH}}   → {OUTPUT_PATH}
{{EMBEDDED_REFERENCE}} → Read these ADW reference files before beginning:
                         - ./.agents/skills/architecture/reference/01-principle.md
                         - ./.agents/skills/architecture/reference/02-building-blocks.md
```

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Architecture — Schema Inventory complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Schemas found:                    N
Called at runtime:                N
Defined but never called:         N
Entry points without schema:      N

Next:
  /architecture/type-dissolution-check {OUTPUT_PATH}
```
