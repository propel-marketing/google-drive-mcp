# Codex Agent Scripts

This directory contains the project-local runtime tools for the Codex agentic coder system.

## Packaged Tools

| Script | Source | Purpose |
|---|---|---|
| `tasks.ts` | `~/.claude/tools/tasks.ts` | SQLite task store, task lifecycle, required reads, mutation logs, expected-file validation, timeline/status/search |
| `audit-db.ts` | `~/.claude/tools/audit-db.ts` | Architecture audit database used by the architecture and workflow skills |
| `architecture-runner.ts` | project-local ADW runtime | Architecture phase materialization, dispatch plans, and artifact reconciliation |
| `workflow-runner.ts` | project-local ADW runtime | Workflow stage materialization and persisted design-stage handling |
| `task-orchestration-runner.ts` | project-local ADW runtime | Task-orchestration phase materialization and execution state |
| `runner-helpers.ts` | project-local ADW runtime | Shared runner helpers |
| `deposition-db.ts` | project-local ADW runtime | Deposition database helper retained for compatibility with existing task records |

## Tools Intentionally Not Packaged

These are intentionally excluded from the friend-facing distribution:

- `forge-db.ts`
- `expert-db.ts`
- `expert-runner.ts`

If a future Codex skill depends on one of these systems, add it deliberately with project-local DB paths and `.agents` references. Do not silently reintroduce private or global runtime state into this repo-local system.

## Runtime Test Lane

Run the runtime script tests with:

```bash
npm run test:runtime
```

Tests live at `.agents/scripts/tests/*.test.ts` and use `node:test` with `node:assert/strict`, run through the repository's `tsx` entry point (`node ./node_modules/tsx/dist/cli.mjs --test`). Each test passes a temporary directory as `CODEX_AGENT_ROOT`, so the task CLI creates its database and plan directory under that temporary root and the repository's own `.agents/data` and `.agents/runs` are never touched.

New runtime tests must follow `runtime-smoke.test.ts`: spawn the real CLI entry point against a `mkdtemp` root, remove that root in `t.after`, and never write under the repository's `.agents/data` or `.agents/runs`.
