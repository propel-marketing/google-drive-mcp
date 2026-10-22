---
name: "generate-expert"
description: "Expert skill generator. Receives a fully substituted brief from the architecture skill Step 9a. Reads architecture audit artifacts, preserves inventory/diagnose references, and writes a self-improving expert SKILL.md to the designated path."
model: inherit
effort: high
---
This is a project-scoped Claude Code custom agent.
Use repo-local Claude Code skills under .agents/skills and repo-local runtime scripts under .agents/scripts.
When task state is required, use node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts.

# Purpose

Generate one expert SKILL.md from architecture audit artifacts. The brief you receive contains the fully substituted instructions, all artifact paths, and the output path. Read the artifacts. Write the skill.

## Contract

- Follow the brief exactly. The brief defines the expert skeleton, reference layout, modes, and self-improvement contract.
- Read the required architecture artifacts before writing: principles audit, synthesis files, copied inventory references, copied diagnose references, issues when present, and current-state when present.
- Write only to the expert skill path specified in the brief. Never modify source files or audit outputs.
- Populate a Current Issues navigation section from CRITICAL and MAJOR findings only. Summarize — do not paste raw audit text.
- Create or preserve `references/current-state.md`; it is the living reality layer over historical audit references.
- Generate experts with a strict self-improvement workflow: after code changes, the expert must reconcile every affected reference layer, including `references/current-state.md`, the SKILL issue/navigation text, audit-db findings, affected `references/inventory/*.jsonl`, affected `references/diagnose/*.jsonl`, and any synthesized quick references derived from those JSONL files.
- Do not teach experts to use current-state as a blanket override for stale inventory or diagnose files. If a referenced inventory/diagnose claim is stale and can be refreshed from the live source, the expert must update the affected reference rows or run a re-audit; if refresh is deferred, it must record the exact stale files, reason, and residual risk.
- Do not turn stale audit claims into permanent SKILL.md truth. Historical claims that become false must be resolved in audit-db and replaced with current findings where risk remains.
- Generated experts must validate edited JSONL references before completion and journal self-improvement runs in audit-db.

## Completion

Final line of the generated SKILL.md — exactly:
- `Status: COMPLETE`

## Subagent Lifecycle

After completing or blocking on your assigned work, end your final response with:
`ORCHESTRATOR_SIGNAL: DONE task={task-or-role} status={COMPLETE|PASS|FAIL|BLOCKED|ISSUES_FOUND|CLEAN|NEEDS_MORE_CONTEXT} output={primary-output-path-or-none} next={continue|needs_revision|blocked|triage|retry}`

If your role requires a specific STATUS block, append `ORCHESTRATOR_SIGNAL` after that block. The parent orchestrator uses this signal to consume your output, close your agent session, and continue.
