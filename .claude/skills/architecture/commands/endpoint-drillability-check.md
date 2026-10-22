---
name: endpoint-drillability-check
description: Score every backend route on the 4-question test (what comes in / out / can fail / user sees) — EXCELLENT, GOOD, POOR, or BROKEN
argument-hint: "<codebase-path> [feature-name] [entry-points-path]"
---

# Endpoint Drillability Check

Reads the entry-points inventory and, for every backend route listed, opens the route file and applies the 4-question drillability test from `03-observability.md`. Each endpoint is scored EXCELLENT, GOOD, POOR, or BROKEN, with POOR/BROKEN endpoints accompanied by an exact list of what is missing and which file currently owns it. Output feeds `/architecture/reflect-and-map`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name] [entry-points-path]

codebase-path        — absolute path to the codebase root (required)
feature-name         — name of the feature or domain to audit (optional; defaults to "full codebase")
entry-points-path    — absolute path to the entry-points inventory output (optional; default derived below)
```

Parse and derive:

```
CODEBASE_PATH      — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME       — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME      — last path segment of CODEBASE_PATH
FEATURE_SLUG       — feature-name lowercased and hyphenated
ENTRY_POINTS_PATH  — from $ARGUMENTS (third token); default:
                     ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/inventory/entry-points.jsonl
OUTPUT_PATH        — ./.agents/runs/architecture/{YYYY-MM-DD}-{FEATURE_SLUG}/diagnose/endpoint-drillability-check.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH:     /abs/path/to/project
FEATURE_NAME:      foundation
CODEBASE_NAME:     Propel-ADW
ENTRY_POINTS_PATH: ./.agents/runs/architecture/2025-01-15-foundation/inventory/entry-points.jsonl
OUTPUT_PATH:       ./.agents/runs/architecture/2025-01-15-foundation/diagnose/endpoint-drillability-check.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`
If ENTRY_POINTS_PATH does not exist, stop: `Cannot run — prior entry-points inventory not found: {ENTRY_POINTS_PATH}`

Verify `{ENTRY_POINTS_PATH}` exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"` before spawning the agent. If not, stop with `Cannot run — prior entry-points inventory at {ENTRY_POINTS_PATH} is incomplete`.

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
[Prior entry-points inventory at ENTRY_POINTS_PATH is the input — every endpoint scored is sourced from it.]
```

---

## Execution

No external template — the full agent brief is inline below. Prepend the Context Block, then send the prompt to one `auditor` agent.

Substitute the placeholders ({CODEBASE_PATH}, {FEATURE_NAME}, {CODEBASE_NAME}, {ENTRY_POINTS_PATH}, {OUTPUT_PATH}) before spawning.

---

```
# Diagnose — Endpoint Drillability Check

You are scoring every backend route in the **{FEATURE_NAME}** feature in **{CODEBASE_NAME}** (`{CODEBASE_PATH}`) on the 4-question drillability test.

## ADW Reference Files

Read these reference files before beginning:
- ./.agents/skills/architecture/reference/03-observability.md

## Prior Output Files

Read this file before beginning. Confirm its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"`.
If it is missing or incomplete, return `Status: NEEDS_MORE_CONTEXT — {ENTRY_POINTS_PATH} is missing or incomplete`.

- {ENTRY_POINTS_PATH}

Output path: {OUTPUT_PATH}

---

## Your job

For every backend route listed in the entry-points inventory, open the route file and read it in full. Apply the 4-question test:

1. **What comes in?** — Is the request shape (body, query, params) declared and validated in this file?
2. **What comes out?** — Is the response shape declared and visible from this file?
3. **What can fail?** — Are the error paths and their conditions visible from this file?
4. **What does the user see?** — Is there a human-readable message returned to the user (TrackingMessage / message field) for both success and failure?

Score each axis as `IN_FILE`, `IMPORTED` (defined elsewhere but referenced here), `IMPLICIT` (not declared, inferred from code), `SCATTERED` (spread across multiple files), `MISSING`, or `DELEGATED` (intentionally handled by a shared helper).

---

## Step 1 — Read each backend route

For each backend route in the entry-points inventory:

1. Open the route file at the cited path.
2. Read it in full — do not skim.
3. If it imports schemas, types, or error helpers from other files, note the imports but do not chase them yet — drillability measures what is visible from THIS file.

---

## Step 2 — Apply the 4-question test

For each endpoint, write:

```
## Endpoint: [METHOD] [path]

File: [absolute file:line]

What comes in:    [IN_FILE | IMPORTED | IMPLICIT | MISSING] — [one line on what was found]
What comes out:   [IN_FILE | IMPORTED | IMPLICIT | MISSING] — [one line]
What can fail:    [IN_FILE | SCATTERED | IMPLICIT | MISSING] — [one line]
What user sees:   [IN_FILE | DELEGATED | MISSING] — [one line]

Score: EXCELLENT | GOOD | POOR | BROKEN
```

Scoring rule:
- **EXCELLENT** — all 4 answers IN_FILE (everything visible from one file)
- **GOOD** — 3 of 4 IN_FILE, the remaining one IMPORTED or DELEGATED to a clearly named helper
- **POOR** — 2 or more answers are IMPLICIT, SCATTERED, or 1 is MISSING
- **BROKEN** — 2 or more answers are MISSING, or "what user sees" is MISSING

---

## Step 3 — For each POOR or BROKEN endpoint, list exactly what is missing

```
## Drillability Gaps

### [METHOD] [path] — Score: [POOR|BROKEN]

Missing in this file:
  - [what] — currently lives in: [file:line | nowhere]
  - [what] — currently lives in: [file:line | nowhere]

To reach EXCELLENT, this file needs:
  - [exact change — e.g. "import RunFoundationBodySchema from contracts.ts and call .parse() on req.json()"]
  - [exact change]
```

---

## Step 4 — Highest-priority endpoint to fix

Pick the single endpoint where fixing drillability would unlock the most agent-readability gain. Justify in one sentence.

```
## Highest-Priority Endpoint

[METHOD] [path] at [file:line] — [one sentence on why this one first]
```

---

## Step 5 — Score totals

```
## Score Totals

EXCELLENT: N
GOOD:      N
POOR:      N
BROKEN:    N

Total endpoints audited: N
```

---

Append as final line (JSON summary record):
`{"_summary":true,"status":"complete"}`
```

---

Spawn one `auditor` agent with Context Block + the filled prompt above.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Endpoint Drillability Check complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Endpoints audited: N | EXCELLENT: N · GOOD: N · POOR: N · BROKEN: N | Highest-priority: {endpoint}

Next:
  /architecture/reflect-and-map {CODEBASE_PATH} {FEATURE_NAME}
```
