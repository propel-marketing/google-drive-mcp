---
name: spec-and-execute
description: "Expedited path for a bounded change whose decisions are already settled: qualify the request, inspect the exact surface, write an implementation-ready Universal Spec in the canonical task-orchestration format, run a readiness check, then convert it to managed tasks and execute them through task-orchestration in the same invocation. Use when the user invokes spec-and-execute or asks to implement a well-understood, limited change without the full architecture or workflow cycle. Do not use for architecture discovery, broad refactors, schema or migration work, security or authorization redesign, deployment changes, unclear requirements, or unresolved product or design decisions."
argument-hint: "<request | planning file or folder [--section <heading>] | --spec <universal-spec.md> | --resume <plan-name>> [--plan-name <name>] [--dry-run] [--allow <protected-area>]"
---

# Spec and Execute

Turn one bounded, already-decided request into a verified implementation in a single invocation: qualify, inspect, write the Universal Spec, check readiness, then hand the spec to `task-orchestration` for conversion and execution. This skill skips the `architecture` and `workflow` layers when their output already exists in the request. It never skips a `task-orchestration` gate, never edits product source before the managed task graph exists, and never replaces managed execution with informal subagent fan-out.

Runtime contract:
- `.agents/skills/task-orchestration/SKILL.md` owns conversion and execution. Read it completely before step 5 and follow it verbatim.
- `.agents/skills/task-orchestration/references/universal-spec-format.md` is the spec grammar. The template in this skill conforms to it; do not invent a different structure.
- `.agents/data/tasks.db`, reached only through `.agents/scripts/tasks.ts`, is the task-state source of truth.
- The parent agent owns every spawned subagent's lifecycle under the repository's subagent lifecycle contract (`AGENTS.md`, mirrored in `CLAUDE.md`), including the `ORCHESTRATOR_SIGNAL` final line.

## Invocation and inputs

Invoke by name through the harness's skill mechanism. Accepted forms:

```text
spec-and-execute <request text>
spec-and-execute <planning file or folder> [--section <heading>]
spec-and-execute --spec <path to an existing universal-spec.md>
spec-and-execute --resume <plan-name>
```

Options:

| Option | Effect |
|---|---|
| `--plan-name <name>` | Use this plan name instead of deriving one. |
| `--section <heading>` | Use only the named heading (and its subsections) of a planning file as source material. Headings are matched case-insensitively by their text. |
| `--spec <path>` | Skip steps 2 and 3; validate the given spec against the canonical format and continue from the readiness check. |
| `--resume <plan-name>` | Skip to step 5 for a plan that already has tasks; continue from `task-orchestration-runner.ts next-actions`. |
| `--dry-run` | Stop after the readiness check. Write the spec and the readiness report; create no tasks and change no product source. |
| `--allow <protected-area>` | Explicitly authorize a protected area named in `AGENTS.md` for this invocation. Repeatable. Without it, work touching a protected area fails qualification. |

Source material, in order of precedence: the invocation text, named planning files or sections, an existing Universal Spec, and any records or artifacts the request names (load them with the Memory Bank tools when they are available in the session). Do not ask the user to restate context that can be verified locally or loaded from a named source.

## 0. Resolve the root and the plan name

1. Run from the repository root and treat the current directory as the project root. Never write an absolute workspace path into a command, script, environment variable or spec; pass paths relative to the root. Where the repository's instructions use a root environment variable, set it from the shell's own current directory, never from a typed path.
2. Derive the plan name from the request or `--plan-name`. It must match `^[a-z0-9][a-z0-9._-]{0,99}$`. Reject anything containing `$`, braces, backslashes, slashes, colons or whitespace; a plan name that fails this rule fails qualification.
3. `PLAN_ROOT` is `.agents/runs/<plan-name>/`. Every artifact this skill writes lives under it. Never create anything else at the workspace root or elsewhere under `.agents/runs`.

## 1. Qualify the work

Proceed only when every condition holds:

- The requested outcome and every product or design decision are settled. A decision that is "probably" settled is not settled.
- The change is bounded: its affected files can be identified through focused inspection, not discovery.
- The codebase already has a suitable local pattern for the change.
- Exact files, symbols, tests and completion checks can be stated before implementation begins.
- The work needs no database migration or schema change, security or authorization redesign, deployment change, public API redesign, broad refactor, or destructive data operation, unless the invocation names that area with `--allow` and the repository's instructions permit it.
- Every protected area named in `AGENTS.md` (or `CLAUDE.md`) that the change touches is authorized, either by the request text or by `--allow`.

When a condition fails: stop before touching product source, state the failed gate and its effect in one short message, and route the request. Design gaps go to `workflow`. Discovery or cross-system diagnosis goes to `architecture` before `workflow`. Do not weaken the request so it fits this skill.

## 2. Inspect the bounded surface

Read only what the spec needs; this is the expedited path.

1. `AGENTS.md` or `CLAUDE.md`, the complete `task-orchestration` skill and its `references/conversion-rules.md` and `references/universal-spec-format.md`.
2. The files the change will touch, their exported symbols, their consumers, and the tests that cover them.
3. The verification commands the repository already uses for those files. Prefer existing commands; a new command is allowed only when the spec also defines the exact new test file.
4. The worktree state. Preserve every unrelated change; do not stash, reset or reformat.
5. Resolve factual questions through code and read-only runtime checks. Any question that turns out to be a product or design decision is a failed qualification gate; report it as such.

Record each verified fact as an evidence row (`E-nnn`) with a `file:symbol` or `file:line` source. Do not edit product source during this step.

## 3. Write the Universal Spec

Write `{PLAN_ROOT}/spec/universal-spec.md` from `references/universal-spec-template.md` in this skill. The template is the canonical format with bounded-spec additions inside it, so `task-orchestration convert-to-tasks` parses it without inference. Replace every placeholder with verified detail and delete the template's instruction lines.

Rules:

- One section per task. Never combine two independent changes in one section.
- At most three File Manifest rows per section. Split sections that need more.
- Every section carries exactly one layer, a phase, its dependencies, its manifest rows, an intent that says why, work items that say what, grep-verifiable acceptance criteria, and an exact verification command that runs from the repository root. Give the command in the shell the harness uses on this platform; when both shells are plausible, give both spellings.
- Symbols required and forbidden are written as they appear in source code.
- Every requirement (`R-nnn`) maps to at least one section and at least one test (`T-nnn`); the requirement table in §1 and the verification matrix in §5 must agree.
- Phases are labeled Feature, Foundation or Cross-cutting; Phase 0 has no dependencies; each Feature phase names its testable outcome.
- Keep the spec proportional to the change. Precision is required; length is not.

With `--spec`, do not rewrite the given file; validate it against the format and the rules above and report every gap before continuing.

## 4. Run the readiness check

Write `{PLAN_ROOT}/spec/readiness.md` with a pass or fail line for each item:

- every requirement maps to implementation work and at least one verification method;
- every file in scope has one owner section and one operation;
- no product or design decision remains open;
- every verification command exists in the repository or the spec defines the exact new test file;
- completion can be proven without subjective claims;
- every section obeys the three-manifest-row limit and the canonical field set;
- the plan name and every path obey the rules in step 0;
- protected areas in scope are authorized.

Fix spec gaps before conversion. If closing a gap requires substantial design analysis, stop and route to `workflow`. With `--dry-run`, stop here and report the spec path, the readiness result, and the recommended next invocation.

## 5. Convert and execute

After readiness passes:

1. Invoke the complete `task-orchestration` skill. `convert-to-spec` is not needed because the spec already exists in the canonical format; begin at `convert-to-tasks` with this plan name.
2. Validate the generated plan before dispatch: every spec section has a builder task and a paired reviewer task, every task's expected files come from the manifest and number three or fewer, dependencies match the spec's phase structure, and test, audit and triage tasks are present where the spec requires them.
3. Run the `execute` workflow of `task-orchestration` without asking the user to invoke it. Dispatch runnable tasks in parallel exactly as that skill prescribes; do not fan out informally.
4. Preserve every builder, reviewer, test-creator, tester, live-runner, resolver and debt-triage gate that `task-orchestration` selects. Completion happens only through `tasks.ts complete`.
5. Stop on the same approval, revision and blocker conditions `task-orchestration` defines. This skill adds no bypass.

With `--resume`, skip to `task-orchestration-runner.ts next-actions` for the named plan and continue the execute loop from its reported state.

## 6. Completion contract

Call the work complete only when `task-orchestration` reports a clean completed plan, final triage is CLEAN, and the spec's verification matrix has passed. Then report:

- the spec path and plan name;
- the final managed-task state, with counts of completed, revised and blocked tasks;
- files changed;
- tests and live checks run, with results;
- review and triage results;
- remaining risk and deferred work, each recorded as follow-up tracked work.

Never commit, push, deploy, migrate data, delete data or publish external changes unless the user explicitly authorized that action in the request. When Memory Bank tools are available and the request named a project or record, record the approved spec as a decision and the completion report as evidence, citing the record and artifact identifiers the request supplied.

## Guardrails

- Keep scope to the approved request. Record newly discovered adjacent problems as follow-up tracked work; do not absorb them.
- Use the repository's exact commands, never guessed equivalents.
- Keep product source unchanged while qualification or readiness fails.
- Follow the repository's managed-task read, mutation, review, test and completion rules without exception.
- Do not re-run an audit or re-derive a design that the request already supplies; cite it.
- Leave the workspace root and `.agents/runs` free of anything that is not the plan's own directory.
