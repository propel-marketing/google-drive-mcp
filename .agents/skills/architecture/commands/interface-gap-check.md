---
name: interface-gap-check
description: Check every layer boundary for a contract — interface, schema, or fully typed function signature; flag DIRECT_REACH and TYPE_ONLY gaps
argument-hint: "<codebase-path> [feature-name] [interfaces-path]"
---

# Interface Gap Check

Reads the interfaces inventory and checks every handoff between layers (UI → API client, route → service, service → DB, service → external API, service → queue) for a defined contract. Classifies each boundary as CONTRACTED, DIRECT_REACH, or TYPE_ONLY (typed at compile time but unenforced at runtime). Also checks whether contracts are centralized in a hub file or scattered. Output feeds `/architecture/reflect-and-map`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [interfaces-path]

codebase-path     — absolute path to the codebase root (required)
feature-name      — name of the feature or domain to audit (optional; defaults to "full codebase")
interfaces-path   — absolute path to the interfaces inventory output (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH    — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME     — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME    — last path segment of CODEBASE_PATH
FEATURE_SLUG     — feature-name lowercased and hyphenated
INTERFACES_PATH  — from $ARGUMENTS (third token); default:
                   ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/inventory/interfaces.jsonl
OUTPUT_PATH      — ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/diagnose/interface-gap-check.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH:   /abs/path/to/project
FEATURE_NAME:    foundation
CODEBASE_NAME:   Propel-ADW
INTERFACES_PATH: ./.agents/runs/architecture/2025-01-15-foundation/inventory/interfaces.jsonl
OUTPUT_PATH:     ./.agents/runs/architecture/2025-01-15-foundation/diagnose/interface-gap-check.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If INTERFACES_PATH does not exist, stop: `Cannot run — prior interfaces inventory not found: {INTERFACES_PATH}`

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
[Prior interfaces inventory at INTERFACES_PATH is the input — boundaries are derived from its handoff points.]
```

---

## Execution

Read `./.agents/skills/architecture/templates/diagnose-interface-gaps.md`.

Substitute:
```
{{CODEBASE_PATH}}  → {CODEBASE_PATH}
{{FEATURE_NAME}}   → {FEATURE_NAME}
{{CODEBASE_NAME}}  → {CODEBASE_NAME}
{{OUTPUT_PATH}}    → {OUTPUT_PATH}
{{PRIOR_FILE_1}}   → {INTERFACES_PATH}
```

Verify `{INTERFACES_PATH}` exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"` before spawning the agent. If not, stop with `Cannot run — prior interfaces inventory at {INTERFACES_PATH} is incomplete`.

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Interface Gap Check complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Boundaries checked: N | DIRECT_REACH gaps: N | TYPE_ONLY gaps: N | Contract hub: CENTRALIZED|SCATTERED|ABSENT

Next:
  /architecture/reflect-and-map {CODEBASE_PATH} {FEATURE_NAME}
```
