# Codex Agent Runtime Install

Installed from the ADW project template.

## What Was Copied

- `AGENTS.md`
- `.agents/skills/`: architecture, execution-integrity, task-orchestration, workflow
- `.agents/scripts/`: task, audit, deposition, workflow, and orchestration CLIs
- `.agents/contracts/`: runner manifests
- `.codex/agents/`: project-scoped subagent configs
- `.codex/hooks/` and `.codex/config.toml`: Codex guardrails

## What Was Not Copied

- `.agents/data/*`: runtime SQLite databases
- `.agents/runs/*`: historical plans, audits, reports, and derived caches
- `.agents/active-plans.json`: replaced with an empty registry
- `.env*`, `.vercel`, build output, and dependencies

## Requirements

The target project needs a Node toolchain capable of running `tsx` and the runtime scripts need `better-sqlite3` plus `commander`.

Recommended dependency setup:

```bash
npm install -D tsx typescript @types/node @types/better-sqlite3
npm install better-sqlite3 commander
```

Then initialize DBs on first use, or run:

```bash
CODEX_AGENT_ROOT="$PWD" npx tsx ./.agents/scripts/audit-db.ts init
CODEX_AGENT_ROOT="$PWD" npx tsx ./.agents/scripts/tasks.ts list --plan smoke
CODEX_AGENT_ROOT="$PWD" npx tsx ./.agents/scripts/deposition-db.ts codebases active --codebase "$(basename "$PWD")"
```

Chrome automation is not copied because it is a Codex plugin installed under `~/.codex/plugins`. Enable the Chrome plugin in Codex for each machine/profile that needs it.
