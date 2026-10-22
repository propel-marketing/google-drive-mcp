---
name: prime
description: "Load the minimum verified context needed to continue work in the current project"
---

# Project Session Primer

Build a concise, evidence-based briefing that explains what the current project is, what changed recently, its current state, and the most likely next work. This skill is read-only. Do not modify project files, Memory Bank, work-tracking, task state, or provenance.

## Step 1: Confirm the Repository and Git State

1. Resolve the repository root and work from it.
2. Record the current branch and whether the working tree is clean.
3. Read the latest 5 commits with dates and subjects.
4. If the tree is dirty, identify the changed paths without interpreting unreviewed content as completed work.

## Step 2: Learn What the Project Is

1. Read `README.md` when it exists.
2. Read `app/README.md` when it exists and the repository contains an application under `app/`.
3. Read at most two clearly named project-context documents under `docs/` only when the README files do not answer a material project question.
4. If no README exists, use the Git remote repository name, package manifest, and top-level directory names to establish a limited project identity. Report that documentation is missing.
5. Treat `AGENTS.md` or `CLAUDE.md`, whichever the harness loaded, as the active development-system contract.

Do not inventory the entire repository. The goal is enough context to continue accurately, not exhaustive codebase analysis.

## Step 3: Load Memory Bank Context

1. Use the installed Memory Bank capability.
2. Resolve the Memory Bank project reference from explicit project documentation first, then the Git remote repository name, then the package name. If those sources conflict, report the conflict instead of guessing.
3. Load bounded context for the resolved project with a goal equivalent to: `Prime this session with recent completed work, current status, active decisions, open questions, and likely next work.`
4. Capture the latest relevant decisions, requirements, evidence, questions, and test results.
5. If Memory Bank is unavailable or no matching project can be resolved, report that limitation and continue with repository evidence. Do not create a new Memory Bank project or substitute memory file.

This step is read-only. Do not add a Memory Bank record while priming.

## Step 4: Read Local Continuity State

1. If `.claude/session-progress.md` exists, read only its latest `## Session:` block first.
2. If `.agents/active-plans.json` exists, read it as a record map and identify any active managed plan.
3. When an active plan exists, use `.agents/scripts/tasks.ts` to read its task state. The task database is authoritative; generated run files and chat memory are not.
4. Use structured Propel-ADW provenance queries only when Git, Memory Bank, and task state leave a material gap about recent activity. Do not read raw transcripts or raw provenance JSONL merely to prime the session.

## Step 5: Read Work-Tracking When Present

1. If `work-tracking/` exists, read `work-tracking/README.md` before interpreting entries.
2. Read `work-tracking/committed.md`, `work-tracking/bugs.md`, and `work-tracking/proposed.md` when each file exists.
3. Do not read all of `work-tracking/done.md`; consult a specific completed entry only when verifying a claim.
4. Respect active migration or retirement notices under `docs/migration/` when they affect whether tracked work remains valid.
5. Treat in-progress entries and open bugs as stronger next-work signals than speculative ideas.

If `work-tracking/` does not exist, continue without treating its absence as an error.

## Step 6: Reconcile and Verify

1. Compare Memory Bank, Git, active-plan state, session progress, and work-tracking sources that exist.
2. When sources disagree, state the conflict instead of selecting the most convenient version.
3. Verify a claimed completed or pending item against the named file, test result, task record, or commit when that status affects what should happen next.
4. Separate confirmed facts, likely next work, and unresolved questions.

## Step 7: Present the Briefing

Use this compact format:

```markdown
## Project
{What the project is and where its application and Propel-ADW infrastructure live.}

## Recently Completed
- {Latest verified work, with commit, test, or Memory Bank evidence where useful.}

## Current Status
- {Branch and worktree state.}
- {Active plan or in-progress work, if any.}
- {Relevant open defects or blockers.}

## Likely Next Work
1. {Highest-confidence next action and why.}
2. {Second action only when independently justified.}

## Unknowns or Conflicts
- {Only items that materially affect the next decision. Omit this section when empty.}

## Sources Consulted
- {Short list of repository files, Memory Bank context, task state, and Git evidence used.}
```

Keep the briefing short. Do not end with a generic question when the evidence identifies a clear next action.
