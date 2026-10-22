---
name: {{COMMAND_NAME}}
description: {{ONE_LINE_DESCRIPTION}}
argument-hint: "<codebase-path> [feature-name]"
---

# {{COMMAND_TITLE}}

{{PURPOSE — one paragraph. What this command audits, what it produces, and what downstream command consumes its output.}}

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
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/{{OUTPUT_SUBDIR}}/{{OUTPUT_FILE}}
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/{{OUTPUT_SUBDIR}}/{{OUTPUT_FILE}}
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

Read `{{TEMPLATE_PATH}}`.

Substitute:
```
{{CODEBASE_PATH}} → {CODEBASE_PATH}
{{FEATURE_NAME}}  → {FEATURE_NAME}
{{OUTPUT_PATH}}   → {OUTPUT_PATH}
{{EMBEDDED_REFERENCE}} → Read these ADW reference files before beginning:
                         - ./.agents/skills/architecture/reference/{{REF_FILE_1}}
                         - ./.agents/skills/architecture/reference/{{REF_FILE_2}}
```

{{IF_SNAPSHOT — include this block only if the command requires a prior snapshot input:}}
Also substitute:
```
{{SNAPSHOT_PATH}} → {SNAPSHOT_PATH}
```
Verify `{SNAPSHOT_PATH}` ends with `Status: COMPLETE` before spawning the agent.
{{/IF_SNAPSHOT}}

Prepend Context Block to the filled template.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Confirm it is `Status: COMPLETE`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
{{COMMAND_TITLE}} complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

{{SUMMARY_LINES — e.g.:
  Enums found:          N
  Magic string gaps:    N
  Highest-priority:     {top finding}
}}

Next:
  {{NEXT_COMMAND}} {OUTPUT_PATH}
```
