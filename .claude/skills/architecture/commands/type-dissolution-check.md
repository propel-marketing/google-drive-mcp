---
name: type-dissolution-check
description: Map every point where type identity is lost in the feature — casts, untyped jsonb, JSON.parse, type widening, implicit any
argument-hint: "<codebase-path> [feature-name] [trace-path]"
---

# Type Dissolution Check

Reads the data-flow trace produced by an earlier diagnose pass and walks each cited file:line to mark every fracture point where a typed value loses its identity (`as any`, untyped `jsonb`, `JSON.parse`, anonymous destructure, type widening, implicit `any`, non-null assertion). Cross-checks each fracture point against schemas defined in the codebase to find unenforced contracts. Output feeds `/architecture/reflect-and-map`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [trace-path]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
trace-path     — absolute path to a prior trace output (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
FEATURE_SLUG   — feature-name lowercased and hyphenated
TRACE_PATH     — from $ARGUMENTS (third token); default:
                 ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/diagnose/trace.jsonl
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/diagnose/type-dissolution-check.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
TRACE_PATH:    ./.agents/runs/architecture/2025-01-15-foundation/diagnose/trace.jsonl
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/diagnose/type-dissolution-check.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If TRACE_PATH does not exist, stop: `Cannot run — prior trace not found: {TRACE_PATH}`

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
[Prior trace at TRACE_PATH is the input — every fracture-point check anchors to a step in that trace.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/diagnose-type-dissolution.md`.

Substitute:
```
{{CODEBASE_PATH}}  → {CODEBASE_PATH}
{{FEATURE_NAME}}   → {FEATURE_NAME}
{{CODEBASE_NAME}}  → {CODEBASE_NAME}
{{OUTPUT_PATH}}    → {OUTPUT_PATH}
{{PRIOR_FILE_1}}   → {TRACE_PATH}
```

Verify `{TRACE_PATH}` exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"` before spawning the agent. If not, stop with `Cannot run — prior trace at {TRACE_PATH} is incomplete`.

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Type Dissolution Check complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Fracture points: N (CRITICAL: N · MAJOR: N · MINOR: N) | Unenforced contracts: N

Next:
  /architecture/reflect-and-map {CODEBASE_PATH} {FEATURE_NAME}
```
