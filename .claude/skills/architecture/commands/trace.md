---
name: trace
description: Trace the 3 most important data structures from origin to consumption and flag dissolution points
argument-hint: "<codebase-path> [feature-name] [snapshot-path]"
---

# Trace

Trace the 3 most central data structures in the feature from creation through transformation to consumption — using the ADW snapshot as the input inventory. At every step, classify the type identity (NAMED / NAMED (cast) / NAMED (inferred) / DISSOLVED / DISSOLVED (cast)) and flag every dissolution point with severity. Produces per-structure journey tables and thread-coherence ratings consumed downstream by `/architecture/type-dissolution-check`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [snapshot-path]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
snapshot-path  — absolute path to adw-snapshot.yaml (optional; derived if omitted)
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
                e.g. /Users/vilovieta/Projects/Propel-ADW → Propel-ADW
SNAPSHOT_PATH  — from $ARGUMENTS (third token); if omitted, derive as
                 ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/snapshot/adw-snapshot.yaml
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/diagnose/trace.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH:  /abs/path/to/project
FEATURE_NAME:   foundation
CODEBASE_NAME:  Propel-ADW
SNAPSHOT_PATH:  ./.agents/runs/architecture/2025-01-15-foundation/snapshot/adw-snapshot.yaml
OUTPUT_PATH:    ./.agents/runs/architecture/2025-01-15-foundation/diagnose/trace.jsonl
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

Verify SNAPSHOT_PATH exists and its last line is `Status: COMPLETE`. If missing: stop with `Cannot run — snapshot missing at {SNAPSHOT_PATH}. Run /architecture/synthesize first.`

Read `./.agents/skills/architecture/templates/diagnose-trace.md`.

Substitute:
```
{{CODEBASE_PATH}} → {CODEBASE_PATH}
{{FEATURE_NAME}}  → {FEATURE_NAME}
{{OUTPUT_PATH}}   → {OUTPUT_PATH}
{{SNAPSHOT_PATH}} → {SNAPSHOT_PATH}
{{EMBEDDED_REFERENCE}} → Read these ADW reference files before beginning:
                         - ./.agents/skills/architecture/reference/01-principle.md
                         - ./.agents/skills/architecture/reference/02-building-blocks.md
                         - ./.agents/skills/architecture/reference/04-diagnostics.md
```

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Trace complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Snapshot:  {SNAPSHOT_PATH}
Output:    {OUTPUT_PATH}

Structures traced: 3 | Dissolution points: N (BLOCKER: N · MAJOR: N · MINOR: N) | Thread coherence: N INTACT · N PARTIAL · N BROKEN

Next:
  /architecture/type-dissolution-check {OUTPUT_PATH}
```
