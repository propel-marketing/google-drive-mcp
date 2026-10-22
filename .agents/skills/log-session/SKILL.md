---
name: log-session
description: "Log session progress to session-progress.md"
---

# Session Progress Logger

Log the current session's progress to `.claude/session-progress.md` with structured formatting, timestamps, and provenance log cross-references.

## Usage

```
/log-session           → Append mode (default)
/log-session overwrite → Overwrite mode (replace entire file)
```

## Instructions

### Step 1: Parse the Argument

- If no argument is provided, or the argument is empty → use **append** mode
- If the argument is `overwrite` → use **overwrite** mode (clears the file and writes a fresh entry)

### Step 2: Identify the Current Session

1. Read `CODEX_THREAD_ID` from the current process environment (`$env:CODEX_THREAD_ID` in PowerShell or `$CODEX_THREAD_ID` in POSIX shells). Trim whitespace and treat an empty value as unavailable.
2. Determine the legacy log directory:
   - Check if `.git` is a file (worktree). If so, parse `gitdir:` to find the main repo root and use `{main_repo}/logs/sessions/`
   - Otherwise, use `logs/sessions/` relative to cwd
3. If the directory contains `.jsonl` files, ignore filenames starting with `.`, select the most recently modified file, and read its first line as the legacy `SessionStart` event.
4. Resolve the session ID in this order:
   1. Use the non-empty `CODEX_THREAD_ID` value.
   2. Otherwise, use `SessionStart.session_id` from the selected legacy JSONL file.
   3. Otherwise, use `unknown`.
5. Resolve the timestamp and provenance independently from the session ID:
   - When a legacy JSONL file exists, use its `SessionStart.timestamp` and set provenance to `logs/sessions/{filename}`.
   - When no legacy JSONL file exists, use the current date/time and set provenance to `unavailable`.

Required resolution cases:

| `CODEX_THREAD_ID` | Legacy JSONL | Session ID | Timestamp | Provenance |
|---|---|---|---|---|
| Present | Missing | `CODEX_THREAD_ID` | Current date/time | `unavailable` |
| Missing | Present | `SessionStart.session_id` | `SessionStart.timestamp` | `logs/sessions/{filename}` |
| Missing | Missing | `unknown` | Current date/time | `unavailable` |
| Present | Present | `CODEX_THREAD_ID` | `SessionStart.timestamp` | `logs/sessions/{filename}` |

### Step 3: Gather Session Context

Review the work done in this session. Collect:
- **Completed tasks**: What was accomplished (with details)
- **Resolved from prior sessions**: Review the most recent prior session's "Remaining Tasks" list. For EVERY item, determine its current status: completed this session, still pending, or made obsolete (with rationale). This is MANDATORY — stale remaining tasks that carry forward without resolution cause future sessions to waste significant time reconstructing state.
- **Remaining tasks**: What still needs to be done. This MUST be the single authoritative list — reconciled against prior sessions, not just new items appended.
- **Active documents**: Any plan, test, or audit documents created, updated, or referenced during the session — with their current status and what they gate/block.
- **Key files**: Files created, modified, or referenced (with their purpose)
- **Decisions**: Important decisions made and their rationale. Include decisions from discussions with the user — especially when a decision supersedes or changes a prior plan.
- **Pipeline metrics** (if a `/dev` pipeline ran): Collect agent invocation count, debug loops, QA score, files changed, lines added/removed. Calculate pipeline duration (Stage 1 start to QA complete) and Gate 2 duration (first user feedback to Gate 2 approval).
- **Gate 2 issue categorization** (if Gate 2 had fixes): Categorize every Gate 2 issue into one of three buckets:
  - **Pipeline-catchable**: Issue directly within sprint scope that the pipeline should have detected — structural bugs, missing deliverables, acceptance criteria violations, behavioral regressions testable by tsc/browser
  - **Visual-subjective**: Issue within sprint scope but requires human aesthetic judgment — layout spacing feel, color preferences, sizing opinions, UX flow preferences
  - **Out-of-scope addition**: Feature or fix requested during Gate 2 that was not in the original scope or acceptance criteria
  The key metric is the **pipeline-catchable count and time** — this is the number that should decrease as pipeline verification improves.

### Step 4: Generate the Session Entry

Format the entry using this exact structure:

```markdown
---

## Session: {timestamp}
**Session ID:** `{session_id}`
**Provenance:** `{provenance}`

### Completed Tasks
- [x] Task description
  - Details about what was done

### Resolved from Prior Sessions
| Prior Remaining Task | Resolution | Rationale |
|---------------------|------------|-----------|
| Task from prior session | Completed / Obsolete / Still pending | Why — e.g., "Done in Assembly Line overhaul Phase 3" or "Superseded by Webpack switch" |

### Remaining Tasks (Authoritative)
- [ ] Task description
  - What blocks it, what it gates, and any referenced documents

### Active Documents
| Document | Status | Gates/Blocks |
|----------|--------|-------------|
| `path/to/plan.md` | Created / In Progress / Executed / Superseded | What depends on this document's completion |

### Key Files
| File | Purpose |
|------|---------|
| path/to/file | Description of purpose |

### Decisions
| Decision | Rationale |
|----------|-----------|
| What was decided | Why it was decided |

### Pipeline Metrics (only for sessions that ran a /dev pipeline)
| Metric | Value |
|--------|-------|
| Workflow | {workflow_id} |
| Agent invocations | {count} |
| Debug loops | {count} |
| QA score | {final score} |
| Known issues | {count} |
| Files changed | {count} |
| Lines | +{added} / -{removed} |
| Pipeline duration | {minutes}m |
| Gate 2 duration | {minutes}m |
| Gate 2 / Pipeline ratio | {ratio} |
| Gate 2 issues — pipeline-catchable | {count} |
| Gate 2 issues — inherently visual/subjective | {count} |
| Gate 2 issues — out-of-scope additions | {count} |

### Gate 2 Issue Breakdown (only for sessions with Gate 2 fixes)
| # | Issue | Category | Notes |
|---|-------|----------|-------|
| 1 | {description} | Pipeline-catchable / Visual-subjective / Out-of-scope | {brief rationale for categorization} |
```

Where:
- `{timestamp}` is the session start timestamp in ISO 8601 format (e.g., `2026-02-11T14:30:00Z`)
- `{session_id}` is the resolved `CODEX_THREAD_ID`, legacy `SessionStart.session_id`, or `unknown`
- `{provenance}` is `logs/sessions/{filename}` when a legacy log exists, otherwise `unavailable`
- Each `---` horizontal rule separates entries

### Step 5: Write the File

**Append mode (default):**
1. Read the existing `.claude/session-progress.md` file
2. If the file doesn't exist or is empty, write the header `# Session Progress Log` followed by a blank line, then the new entry
3. If the file exists with content, append the new entry after the last line (the `---` at the start of the entry template serves as the separator)

**Overwrite mode:**
1. Write the file with the header `# Session Progress Log` followed by a blank line, then a single new entry
2. All previous entries are removed

### Step 6: Confirm

After writing, report to the user:
- The mode used (append or overwrite)
- The session ID logged
- The file path written to

### Step 7: README Update Checks

After the session log is written, check whether either README needs updating. The workspace has two README files with distinct scopes:

- **Root README** (`README.md`) — pipeline infrastructure, architecture, deployment, operational procedures
- **App README** (`app/README.md`) — application codebase (features, components, API routes, database)

**Change detection:** Use the **Key Files** table from Step 3 to determine scope:
- Paths starting with `app/` → app changes (triggers Step 7B)
- Paths NOT starting with `app/` (e.g., `.claude/`, `scripts/`, `CLAUDE.md`) → infrastructure changes (triggers Step 7A)
- Both can be true in one session

#### Step 7A: Root README (`README.md`) — Pipeline & Infrastructure

1. **Check relevance**: If no key files from this session are outside `app/`, skip with: "Root README: no infrastructure changes this session"
2. **Read** `README.md`
3. **Compare** the session's completed tasks and key files (non-`app/` only) against the README sections:
   - Do completed tasks affect any documented pipeline feature, workflow, or structure?
   - Were new commands, agents, hooks, scripts, or directories created that the README should reflect?
   - Were existing infrastructure features modified in ways that make README descriptions inaccurate?
   - Was the project structure changed (new folders, moved files)?
4. **If no updates needed** — report "Root README is up to date"
5. **If updates needed** — present a **single prompt** to the user summarizing all required changes:
   - Group by README section (e.g., "Project Structure", "Key Files", "Development Pipeline")
   - Keep each item to 1-2 sentences describing what needs updating and why
   - Ask the user to approve or skip
6. **If approved** — apply the changes to `README.md`
7. **If skipped** — continue without modifying `README.md`

**Prompt format example:**
```
Root README (README.md) updates needed:

- **Project Structure**: Add `logs/sessions/` directory to the tree (was missing)
- **Key Files**: Add `/log-session` command entry
- **Development Pipeline**: Update agent count from 6 to 7

Apply these updates to README.md?
```

#### Step 7B: App README (`app/README.md`) — Application Codebase

1. **Check relevance**: If no key files from this session are inside `app/`, skip with: "App README: no application changes this session"
2. **Read** `app/README.md`
3. **Detect boilerplate**: If the file contains Next.js starter content (e.g., "bootstrapped with" or "This is a [Next.js]") and lacks a `## Features` section, it needs bootstrapping — go to step 4. Otherwise, go to step 5.
4. **Bootstrap** (boilerplate detected):
   - Read the root `README.md` to reference existing feature documentation, tech stack, and architecture
   - Propose an initial project-specific structure for `app/README.md` with sections: Overview, Tech Stack, Features, Project Structure, Getting Started, Environment Variables, Database, API Routes — populated from what's already known about the app
   - Present to user for approval. If approved, write the bootstrapped content. If skipped, continue.
5. **Incremental update** (already project-specific):
   - **Compare** the session's completed tasks and key files (`app/` only) against the app README sections:
     - Do completed tasks affect any documented feature, component, or API route?
     - Were new components, routes, database tables, or libraries added that the README should reflect?
     - Were existing features modified in ways that make README descriptions inaccurate?
   - **If no updates needed** — report "App README is up to date"
   - **If updates needed** — present a **single prompt** summarizing all required changes, grouped by section. Ask the user to approve or skip.
   - **If approved** — apply the changes to `app/README.md`
   - **If skipped** — continue without modifying `app/README.md`

**Prompt format example (incremental):**
```
App README (app/README.md) updates needed:

- **Features**: Add Google Picker API integration (replaced custom Drive folder browser)
- **API Routes**: Add `GET /api/google/drive/token` endpoint
- **Environment Variables**: Add `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` and `NEXT_PUBLIC_GOOGLE_PICKER_APP_ID`

Apply these updates to app/README.md?
```

### Work-Tracking ID Assignment

Work lives in `work-tracking/` (see `work-tracking/README.md`). When creating new entries (in Step 8 or elsewhere):

1. Check the current branch:
   ```bash
   git branch --show-current
   ```
2. If the branch starts with `worktree-`:
   - Use `R-###` as the ID (literal placeholder, NOT a real number)
   - Add `- **Worktree:** {worktree-name} #{sequence}` as metadata on the entry
   - Sequence: count existing `Worktree: {worktree-name} #` entries across `work-tracking/*.md` and increment
3. If on `main`: **next ID = (highest `R-###` across ALL `work-tracking/*.md` files) + 1.** IDs are global and monotonic — never reused, never renumbered when an item moves between files.

### Step 8: Work-Tracking Update Check

After the README check, review `work-tracking/` for accuracy based on the session's work. **In this system a status change is usually a FILE MOVE, not an in-place edit** (see `work-tracking/README.md` lifecycle).

1. **Read** the live files: `work-tracking/proposed.md`, `committed.md`, `bugs.md` (read `done.md` only to confirm something already shipped).
2. **Compare** the session's completed tasks, key files, and decisions against entries. Check for:
   - **Shipped work** — Did we complete an item? → **MOVE** its entry to `done.md`, set `Status: Done`, add `Implemented: <date> — <summary>`, and remove it from its source file.
   - **Promotions** — Did a `proposed` item become committed? → **MOVE** it to `committed.md` (`Status: Backlog` | `In Progress`), keeping its `R-###`.
   - **Started work** — Did we begin an item? → set `Status: In Progress` in place.
   - **New defects** — Did we surface a bug in shipped functionality? → it belongs in `bugs.md`.
   - **Description/scope updates** — discoveries that change an entry's body.
3. **If no updates needed** — report "Work-tracking is up to date" and finish
4. **If updates needed** — present a summary grouped by R-### item (noting any file moves). Ask the user to approve or skip
5. **If approved** — apply the changes (move entries between files per the README lifecycle; never reuse or renumber IDs)
6. **If skipped** — finish without modifying work-tracking

**Untracked ideas:** If new ideas, problems, or enhancements were discussed but no corresponding R-### entry exists, output a notice naming where each would go (`proposed.md` speculative, `committed.md` if we'll build it, `bugs.md` if broken):

```
Note: The following idea(s) were discussed but are not tracked in work-tracking/:
- {brief description of idea} → would go in {proposed|committed|bugs}.md
```

Do NOT create new entries automatically. The user decides whether and how to add them.

**Prompt format example:**
```
Work-tracking updates needed based on this session:

- **R-003** (Build Pipeline): ship → MOVE to done.md, Implemented: Created implementer.md, reviewer.md, tester.md, debugger.md. Verified end-to-end with email validator workflow.
- **R-006** (Parallel Micro-Tasks): promote proposed → committed; added 4 required changes to the body.

Apply these updates to work-tracking/?
```
