# Codex Agent Protocol

This repo has a Codex-native agentic coder system under `.agents/`. Use it for substantial design, audit, planning, and multi-step implementation work.

## Core System

- `.agents/skills/architecture/SKILL.md` audits code and produces architecture artifacts, issues, and specs.
- `.agents/skills/workflow/SKILL.md` is the design layer. It turns a request into a complete implementation blueprint.
- `.agents/skills/task-orchestration/SKILL.md` converts specs into executable tasks and coordinates execution.
- `.agents/skills/spec-and-execute/SKILL.md` is the expedited path for a bounded change whose decisions are settled: it qualifies the request, writes the Universal Spec in the canonical format, runs a readiness check, and drives `task-orchestration` conversion and execution in one invocation without bypassing any gate.
- `.agents/skills/execution-integrity/SKILL.md` audits runtime reliability, task lifecycle correctness, orchestration, and recovery paths.
- `.agents/scripts/tasks.ts` is the task runtime. It owns task state, the SQLite task DB, expected-file contracts, read logs, mutation logs, and completion validation.
- `.codex/agents/*.toml` contains project-scoped Codex custom subagents for the ADW system. These agents run in their own context and inherit/use the repo-local skills.
- `.codex/config.toml` enables lightweight Codex boundary hooks. The four guard scripts (`agent_runtime_policy.ts`, `comment_guard.ts`, `managed_plan_stop_gate.ts`, `task_completion_ping.ts`) are one shared set that Claude Code runs through `.claude/hooks/run-codex-guard.ts`; `agent_runtime_policy.ts` blocks old `~/.claude/tools` runtime calls and direct `.agents/data` DB mutation.

## Default Workflow

For substantial feature work or refactors:

1. Use `workflow` to produce a universal spec.
2. Use `task-orchestration convert-to-tasks` to create DB-backed tasks.
3. Execute one task at a time using `.agents/scripts/tasks.ts`.
4. Run the task's verification command before completion.
5. Complete only through `tasks.ts complete`.

For a bounded change whose product and design decisions are already settled, use `spec-and-execute` instead: it produces the spec and runs steps 2 to 5 in one invocation, applies the same qualification and readiness gates, and stops on the same approval and blocker conditions.

For runtime behavior concerns, use `execution-integrity` to audit live workflow reliability and turn findings into task-orchestration work. Tester subagents live in `.codex/agents/` for task plans that explicitly call them, but this distribution does not include standalone testing skills.

For architecture analysis, use `architecture` first. For small direct fixes, a full plan is optional, but still follow the repo's existing code patterns and run focused verification.

## Engineering Doctrine

Write code as a senior engineer and architect would: the least code that fully delivers the outcome, built on what already exists, readable from its names alone, diagnosable from its output alone, and split along the boundaries the domain already has. These doctrines govern every change in this repository and in any repository this ADW operates. Their IDs are stable: cite them as `Doctrine #1` through `Doctrine #6` and link to `#Doctrine-1` through `#Doctrine-6`. Preserve existing IDs when adding doctrines.

1. <a id="Doctrine-1"></a> **Doctrine #1 — Build only what the outcome needs.** Deliver the agreed outcome with the least code that fully does the job. Add no abstraction, option, flag, layer, generic or extension point that has no consumer in this change; three similar lines beat a premature helper. Remove what the change orphans (imports, exports, branches, flags, stubs) in the same change; dead code is a false promise to the next reader. Count cost in reader attention, tokens and runtime together: the code that is cheapest to read is usually cheapest to run, and a hot path or a known scale is designed for, not guessed at.

2. <a id="Doctrine-2"></a> **Doctrine #2 — Prefer the proven path.** Before writing anything new, look for the established solution in this order: the pattern or owner module this codebase already uses, a dependency already installed, a maintained library or the platform's native capability. Grep first. Write new code only for the demonstrated gap those cannot meet, keep it thin over the proven piece, and name the pattern followed or the gap found in the task's `patternAlignment`. Reimplementing an existing utility inline is a defect, not a shortcut. Inside existing code the local convention outranks this doctrine's preferences; changing a convention is its own change.

3. <a id="Doctrine-3"></a> **Doctrine #3 — Names and types carry the meaning.** Name every folder, file, function, class and variable for its domain role and trust stage (`rawWebhookPayload` → `parsedOrder` → `persistedOrderRecord`): verb-noun for operations, noun for holders, role names only for structural files. A name that refuses nothing is forbidden: `data`, `result`, `payload`, `item`, `tmp`, `helper`, `utils`, `common`, `Manager`, `Handler`, `Service`, `process`, `handle`, unless qualified by a domain role. A set of valid values is a closed type; untrusted input is parsed by a schema where it enters and the type is derived from the schema; a value keeps its type from entry to consumption, never dissolving into `any` or an anonymous shape. The test is the grep test: a core concept must read as one story from origin through transformation to consumption, run before the work and again after it.

4. <a id="Doctrine-4"></a> **Doctrine #4 — Write no comments; make the code say it.** Source files carry no comments. The urge to write one means the structure is not yet clear: rename, split, type or restructure until the reader does not need it, then write nothing. This holds for comments the guard cannot see as well, such as a comment trailing a code line or one in a file type the guard does not check. A reason the code cannot encode (a hidden constraint, a workaround for a specific bug, a decision taken) lives in the spec's intent, the commit message and the decision log, never inline; agent instructions never live in source comments. The comment guard enforces this doctrine and is not weakened to admit exceptions.

5. <a id="Doctrine-5"></a> **Doctrine #5 — Every failure tells the fixer what happened, where, and what to do next.** Routine failures are typed results the caller must handle; exceptions are for bugs and infrastructure. Every boundary reports its outcome with a greppable location (`[Owner.operation]`), the key identifiers, the outcome and the duration, and on failure the full error with its stack and the next action. Never swallow an error, never rethrow without adding context, never return `null` for a failure, never log a bare message. Validate untrusted input where it enters so corruption fails at the edge with a specific error. Error output that another agent or tool reads is structured: a stable `code`, a plain-language `error`, the `details` the reader needs, and a `nextAction`; file paths in shared output are tokenized, never machine-absolute. The test: from the output alone, an agent can trace and fix the failure without opening a debugger.

6. <a id="Doctrine-6"></a> **Doctrine #6 — One responsibility per unit; size signals role.** A function does the one thing its name says; a file holds one operation or one domain holder; an operation has exactly one owner. A function that no longer fits on one screen (about 40 lines) or has more than one reason to change is split now, not later. A non-orchestrator file past about 200 lines is a split candidate unless splitting would invent a boundary the domain does not have; composition roots, orchestrators, protocol adapters and aggregation files (schemas, registries, constants) are judged by completeness instead. Barrel indexes only re-export; the composition root is the only place that wires; a domain owns its folder with no `utils/`, `helpers/` or `types/` folder inside it; tests mirror the source. A task touches at most three files; more is a split, declared in the plan.

When doctrines, rules and local facts conflict, apply them in this order, and never let a lower layer weaken a higher one: correctness, security and data integrity of the running system; the task's spec, manifest and acceptance criteria; the convention already used by the file and module being changed; these doctrines' defaults. The Architecture Defaults and Quality Rules below are the mechanical consequences of these doctrines; reviews, self-audits and triage cite the doctrine ID a finding violates.

## Live Testing And Neon

When a feature needs proof that it works through the running app, use the target repo's existing live test commands against a real server. Mocked route tests, mocked integration tests, and route-caller tests are useful regression coverage, but they are not final live-system proof.

For database-backed live tests:

1. Use a Neon child/test branch, preferably a short-lived branch created from `production`.
2. Use that branch's pooled Postgres connection string as `DATABASE_URL`.
3. Set `REAL_DB=1` for real DB integration tests that are guarded by that flag.
4. Start the app with the same Neon branch env that the tests should exercise.
5. Run the target repo's live HTTP verification command against `<local-or-preview-url>`.

Do not commit real Neon URLs, database passwords, Clerk secrets, Vercel secrets, or local `.env*` files. Put temporary secrets in the shell environment or local ignored env files only.

If a test plan marks real DB verification as deferred because `REAL_DB` or `DATABASE_URL` is missing, do not treat the feature as fully validated. Either run it against the Neon branch or leave the residual risk explicitly documented.

## Live Queue Testing: QStash And Inngest

Do not treat mocked QStash or mocked Inngest tests as final proof for queue/workflow behavior. Mocks are acceptable only for contract/unit coverage or deterministic failure injection. Live queue verification must use the real queue/runtime path and capture persisted evidence.

For Inngest-backed flows:

1. Start the app with `INNGEST_DEV=1` and the intended Neon branch `DATABASE_URL`.
2. Start the Inngest dev server against the live app URL:
   ```bash
   npx inngest-cli@latest dev -u http://localhost:3004/api/inngest --port 8288
   ```
3. Trigger events through the Inngest dev server or through the real app route that emits the event.
4. Verify by polling durable app state in Neon and, when useful, the Inngest dev server GraphQL API at `http://localhost:8288/v0/gql`.
5. Use the existing live-test pattern in `tests/inngest/*.live.test.ts`; gate live tests with `LIVE=1`.

For QStash-backed flows:

1. QStash cannot deliver to plain `localhost`. Use a Vercel preview/production deployment or a public tunnel to a production-mode local server.
   - Vercel CLI access is available in this workspace and should be used when a real public callback URL is needed for non-mocked QStash delivery.
   - Prefer a Vercel preview deployment for feature-branch validation, wired to the Neon child/test branch env.
2. The app's `publishPhase()` uses real QStash only when `NODE_ENV=production`, `QSTASH_TOKEN`, and `QSTASH_URL` are set. Ordinary `npm run dev` uses the local fire-and-forget fallback and is not QStash proof.
3. Set `NEXT_PUBLIC_BASE_URL` to the public URL that QStash can call, and set `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` so internal handlers verify real Upstash signatures.
4. Trigger the public app action that publishes the QStash message, then verify the internal handler ran by polling Neon state, job status, phase data, and any emitted task/workflow records.
5. Use the Upstash console or API only as supporting evidence; the acceptance signal must be persisted app behavior, not just "message accepted".

When a no-mock queue test is requested, prefer the closest live lane:

- Inngest: local app + Inngest dev server + Neon branch.
- QStash: Vercel preview or production-mode tunneled app + real Upstash QStash + Neon branch.

If credentials, a public callback URL, or an Inngest/QStash runtime is unavailable, leave the result as an explicit residual risk. Do not downgrade it to a mocked pass.

## External Access

- GitHub access is connected for this workspace. For now, only work on the `Propel-ADW` GitHub repository unless the user explicitly redirects the session.
- Vercel CLI access is connected for this workspace. Do not assume a Vercel project mapping; confirm the target project with the user before deployment or deployment validation.
- Use Vercel CLI for real preview deployment checks and public callback URLs when validating non-mocked QStash delivery.
- Whenever work is deployed through GitHub, verify the deployment in Vercel before considering the deploy successful. Check the relevant Vercel deployment status, build logs, and production/preview URL as applicable.
- If local Vercel project linkage does not point at the user-confirmed target project, stop and resolve the mapping before deploying or validating a deployment.

## Orchestrator Contract

The orchestrator system has four distinct layers. Keep their responsibilities separate.

1. `architecture`
   - Use first for architecture audits, issue generation, and spec-ready remediation context.
   - `architecture` owns audit artifacts and architecture issues.

2. `workflow`
   - Use after `architecture` for substantial features or refactors that need a durable implementation design.
   - `workflow` turns request context and architecture findings into a universal spec.

3. `task-orchestration`
   - Use after `workflow` to convert the spec into executable managed tasks.
   - `task-orchestration` owns task graph creation, review/triage flow, and execution convergence.

4. `tasks.ts`
   - `tasks.db` is the runtime source of truth for managed plans.
   - Do not treat chat state, marker files, or generated caches as authoritative task state.

## Subagent Lifecycle Contract

This applies to any subagent deployment from any skill, workflow, test pipeline, architecture run, or one-off helper.

- The parent agent that spawns a subagent owns that child agent's lifecycle.
- Every spawned subagent prompt must require a final `ORCHESTRATOR_SIGNAL` line:
  `ORCHESTRATOR_SIGNAL: DONE task=<task-or-role> status=<COMPLETE|PASS|FAIL|BLOCKED|ISSUES_FOUND|CLEAN|NEEDS_MORE_CONTEXT> output=<primary-output-path-or-none> next=<continue|needs_revision|blocked|triage|retry>`
- If the subagent's own instructions require a specific status block, append `ORCHESTRATOR_SIGNAL` after that block. The signal is parent-control metadata, not the task report.
- After `wait_agent` returns, the parent must read the final response, consume the named output, verify persisted task/report state, then call `close_agent` for that child before advancing.
- If a child times out or omits `ORCHESTRATOR_SIGNAL`, inspect task state and output files, send at most one corrective message if recovery is likely, otherwise close the child and respawn a replacement. Do not leave idle completed agents open.
- Hooks may record completion events, but hooks are guardrails only. They do not replace the parent responsibility to consume, close, and continue.

## Managed Plan Rules

- Active plan discovery is registry-based via `.agents/active-plans.json`.
- Do not reintroduce singleton active-plan markers.
- Runner scripts own orchestration state transitions and completion checks.
- Hooks are guardrails only; they must not be treated as the workflow engine.
- Cache files under `.agents/runs/*` are derived views, not primary control state.

## Task Runtime Contract

When working a managed task, the task DB is the source of truth. Do not rely on conversation memory as task state.

Run the commands from the repository root. The command is the same in Bash and PowerShell; the runtime derives the repository root from the current directory. `CODEX_AGENT_ROOT` is an optional override and, when set, must be an absolute path to a checkout containing `.agents/`. Never embed a machine path in a script, spec, task record or instruction; pass paths relative to the repository root.

Use:

```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts get --plan <plan> --task-id <task>
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts start --plan <plan> --task-id <task> --caller builder
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-read --plan <plan> --task-id <task> --path <path> [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-mutation --plan <plan> --task-id <task> --path <path> [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts complete --plan <plan> --task-id <task> --caller builder --discovered-context-file .agents/runs/<plan>/agent-outputs/<task>/discovered-context.json --self-audit-file .agents/runs/<plan>/agent-outputs/<task>/self-audit.json
```

`log-read` and `log-mutation` accept several paths in one call and log one event per path; a call with any missing or undeclared path logs nothing. `complete` reads the discovered context and the self-audit from JSON files written under the task's `agent-outputs` directory; the inline `--discovered-context <json>` and `--self-audit <json>` options remain accepted, and exactly one form of each must be passed. Prefer the file form: it needs no shell quoting.

`tasks.ts complete` must fail if required reads are missing, expected files are not created/modified/deleted, required symbols are absent, forbidden symbols are present, or discovered context/self-audit is missing.

Do not use `tasks.ts update` to mark tasks `in_progress` or `completed`; use `start` and `complete` so lifecycle events and validation run. Do not write `filesRead` or `fileMutations` directly; use `log-read` and `log-mutation`.

## Quality Rules

- Read required files before editing and log those reads for managed tasks.
- Log every file mutation for managed tasks.
- Keep each task scoped to the files declared in `filesExpected`; split tasks that exceed three expected files.
- Use existing Propel-ADW patterns before inventing new abstractions.
- Prefer grep-verifiable names, explicit contracts, and typed boundaries.
- Completion summaries should reflect verified state: files changed, tests run, and any residual risk.
- Do not edit `.agents/data/*` or generated `.agents/runs/*/task-list.json` directly. Use `.agents/scripts/*.ts` so schema initialization, validation, and cache syncing remain consistent.

## R-Item Reference Format

- Whenever an R-item is referenced in chat, plans, specifications, task records, Memory Bank entries, reports, commits, or other communication, write the permanent ID followed by a short descriptive label: `R-### (Label)`.
- Keep the label to five words or fewer and choose recognizable keywords from the R-item's canonical title.
- Do not use a bare R-item ID when discussing or linking work. Repeat the label on later references so readers do not need the work-tracking files open.
- When listing multiple R-items, label each item individually instead of using an unlabeled numeric range.
- Example: `R-123 (Frontend UI Accessibility Improvements)`.
- Canonical work-tracking headings may retain their repository format, such as `### R-123: Improve frontend UI accessibility`, because the heading already supplies the full title.

## Architecture Defaults

Apply these lightweight ADW principles even when the full `architecture` skill is not in use:

- Preserve the grep thread. Core domain concepts should have canonical, specific names that trace from origin to transformation to consumption. Avoid generic names like `data`, `result`, `payload`, `manager`, `helper`, or `utils` unless they are qualified by a domain role.
- Prefer imports and named building blocks over inline anonymous shapes. Put reusable schemas, types, interfaces, enums, and classes behind exported names so agents and humans can grep them.
- Validate trust boundaries at runtime. External API responses, route inputs, webhook bodies, file reads, database JSON, and user input should pass through schemas at the entry point. Derive TypeScript types from schemas when a schema is the source of truth.
- Keep layer boundaries explicit. Route handlers should call services through clear contracts; services should not reach through repositories, clients, or implementation internals without an established local pattern.
- Give behavior one owner. Classes and modules should have names that state purpose, usually verb-noun for operations or precise nouns for registries/state. Avoid scattering one operation across routes, helpers, and services.
- Use enums or const value sets for closed vocabularies. Do not repeat magic strings for statuses, phases, kinds, or tool names across files.
- Keep files role-shaped. Small barrel `index` files should only re-export. Composition roots wire dependencies. Non-orchestrator files that grow past roughly 200 lines need a responsibility check before adding more.
- Keep structure domain-first below inflection points. Nested `helpers/`, `utils/`, or `types/` folders inside domain folders are a smell; prefer domain-named files and a local `types.ts` when needed.

## Project Structure

```text
.agents/                     native ADW runtime; the source of truth
  contracts/                 stage manifests the runners read
  data/                      runtime databases, gitignored: tasks.db, audit.db, deposition.db
  provenance/                provenance ledger tooling and its tests
  runs/<plan-name>/          managed-plan artifacts, gitignored: spec/, AGENT_SYSTEM.md, agent-outputs/
  scripts/                   tasks.ts, the runners, runner-helpers.ts, tests/*.test.ts (npm run test:runtime)
  skills/                    architecture, workflow, task-orchestration, spec-and-execute, execution-integrity, ...
.claude/                     Claude Code compatibility kit, generated from .agents/ and .codex/
  agents/ skills/ commands/  mirrors; regenerate them, never edit them by hand
  compatibility/             generate and verify scripts, schemas, native baseline and approval manifests
  hooks/ settings.json       Claude hook bridges
  tests/                     parity and host-install tests, run by scripts/init.mjs
  worktrees/<name>/          session worktrees; the only place a second checkout of this repo may live
.codex/                      agents/, hooks/ and config.toml for the .codex harness
docs/planning/               program plans; fixtures/ (smoke plan) and metrics/ (baselines)
scripts/init.mjs             initializer and verification gate: node scripts/init.mjs --check
AGENTS.md                    instructions; CLAUDE.md is its generated mirror
```

Folder rules:

- One folder per repository. Branch work happens in this checkout on a branch; create a worktree only when two sessions must run on this repository at once, and only under `.claude/worktrees/<name>/`, never beside the repository. Keep `.claude/worktrees/` ignored by git.
- Remove a worktree after its pull request merges (`git worktree remove`), after copying any `.agents/runs/<plan-name>/` artifacts worth keeping into this checkout.
- Create nothing at the repository root or elsewhere under `.agents/runs/` outside a plan's own directory; backups and snapshots never live beside the repository.

## Local State

Project-local agent state lives under `.agents/`:

- `.agents/data/tasks.db`
- `.agents/data/audit.db`
- `.agents/data/deposition.db`
- `.agents/runs/<plan-name>/`

`.agents/data/` contains runtime databases, not source artifacts. These DBs are initialized on first tool use and populated as Codex agent skills run. Empty DBs usually mean no architecture audits or task plans have been recorded yet.

Do not write new Codex workflow state into `~/.claude`.
