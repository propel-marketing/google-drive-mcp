---
name: architecture-entry-points
description: Inventory every place untrusted data enters the system and score backend route drillability.
argument-hint: "<codebase-path> [feature-name]"
---

# Architecture — Entry Points Inventory

Catalog every place where data crosses from outside the system into trusted code: HTTP route handlers, server actions, webhooks, frontend forms and API calls, database result consumption, external API responses, and config/env reads. For each backend route, apply the four-question drillability test (what comes in, what comes out, what can fail, what does the user see) and score it EXCELLENT/GOOD/POOR/BROKEN. Produces a complete entry-points inventory at `inventory/entry-points.jsonl` that the endpoint-drillability-check command consumes.

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
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/inventory/entry-points.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/inventory/entry-points.jsonl
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

Read `./.agents/skills/architecture/templates/inventory-entry-points.md`.

Substitute:
```
{{CODEBASE_PATH}} → {CODEBASE_PATH}
{{FEATURE_NAME}}  → {FEATURE_NAME}
{{OUTPUT_PATH}}   → {OUTPUT_PATH}
{{EMBEDDED_REFERENCE}} → Read these ADW reference files before beginning:
                         - ./.agents/skills/architecture/reference/01-principle.md
                         - ./.agents/skills/architecture/reference/02-building-blocks.md
                         - ./.agents/skills/architecture/reference/03-observability.md
```

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Architecture — Entry Points Inventory complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Entry points:   N
Guarded:        N
Unguarded:      N
Drillability:   N EXCELLENT · N GOOD · N POOR · N BROKEN

Next:
  /architecture/endpoint-drillability-check {OUTPUT_PATH}
```
