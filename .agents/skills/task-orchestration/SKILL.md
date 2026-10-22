---
name: task-orchestration
description: Universal task pipeline. Converts any planning material into executable tasks and dispatches agents to run them. Three commands — convert-to-spec (raw material → Universal Spec), convert-to-tasks (spec → task list), execute (spawn agents). Works with /architecture:audit-to-spec output but accepts any structured planning material.
argument-hint: "<convert-to-spec|convert-to-tasks|execute> <source-path-or-plan-name>"
---

# Task Orchestration

Runtime contract:
- `.agents/contracts/task-orchestration.manifest.json` is the authoritative stage/supervisor graph.
- `.agents/scripts/task-orchestration-runner.ts` owns stage materialization, next-action derivation, and convergence checks.
- This skill explains execution policy; the manifest and runner own persisted orchestration state.
- The parent orchestrator owns subagent lifecycle. Every spawned agent must finish with an orchestrator signal; after the parent consumes the final response and verifies persisted output, the parent must close that child agent before advancing.

Universal pipeline for converting planning material into work and getting that work done. Three stages run in sequence — each can be invoked independently when its input already exists.

**You are the orchestrator. You do this work directly — no subagents for planning stages.**

Task creation is not delegated. You read the material, you classify sections, you write descriptions, you call `node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts create` yourself. Every task description you write is the **complete and sole context** a builder agent will have. No conversation history, no prior context, no ability to ask questions mid-execution. If a detail is missing from the description, the agent guesses.

---

## Path Resolution (resolve first, before any command)

At the start of every command, resolve these four values. Everything else derives from them.

```
CODEBASE_NAME  = basename of the current working directory (e.g. Propel-ADW)
CODEBASE_PATH  = the codebase root, which is the current working directory (never typed into a file or command)
AGENT_ROOT     = .agents
PLAN_ROOT      = {AGENT_ROOT}/runs/{plan-name}
```

`AGENT_ROOT` is the single source of truth for Codex workflow files, task records, agent outputs, and local SQLite databases for this codebase. Every file path in this skill is relative to `PLAN_ROOT`. Every command runs from the codebase root with no root prefix; `CODEX_AGENT_ROOT` is an optional override that stays unset in normal use. No machine path is ever written into a task record or `AGENT_SYSTEM.md`.

**If `AGENT_ROOT` does not exist, create it:**
```bash
mkdir -p .agents/runs
```

**Verify resolution before proceeding:**
```
CODEBASE_NAME:  {value}
CODEBASE_PATH:  {value}
AGENT_ROOT:     {value}
PLAN_ROOT:      {value}
```

---

## Command: convert-to-spec

**Invocation:** `/task-orchestration convert-to-spec <source-path>`

Reads raw planning material and produces a Universal Spec file.

### Accepted Input Types

| Type | Signal | Approach |
|---|---|---|
| `/architecture:audit-to-spec` output | Has numbered findings, File Manifest section | Direct extraction — map findings to sections |
| Free-form design notes | Prose descriptions, verb phrases | Infer intent → extract sections → derive manifest |
| Code files to audit | `.ts`, `.py` source files | Architecture audit first, then convert findings |
| Mixed folder | Multiple file types | Read all, synthesize, classify |

### Steps

1. Read all files at `<source-path>`
2. Identify plan name from content (prompt user if ambiguous)
3. Consult `references/conversion-rules.md` for classification logic
4. Extract or infer each section — group related changes to same file
5. Classify each section by layer: `schema|service|route|component|hook|config|test|test-assess|live|audit|infra|contract`
6. Build File Manifest — every section must map to ≥1 file with op (`create`/`modify`/`delete`)
7. Extract symbols required/forbidden per file from spec directives
8. Assign phases using dependency rules from `references/conversion-rules.md`
9. Write Universal Spec to output path using `references/universal-spec-format.md` as template

**Output:** `{PLAN_ROOT}/spec/universal-spec.md`

**Quality gate — do not finalize until:**
- [ ] Every section has a layer label
- [ ] Every section has ≥1 manifest row
- [ ] No section has >3 manifest rows (split if more)
- [ ] Phase 1 sections have no dependencies
- [ ] Later phases only depend on earlier phases
- [ ] Constraints section is not empty

---

## Command: convert-to-tasks

**Invocation:** `/task-orchestration convert-to-tasks <plan-name>`

Reads `universal-spec.md` and creates task records one at a time.

**Prerequisite:** `convert-to-spec` must have run first.

### Phase Principle: Prefer Vertical Slices

**Prefer phases organized around domain capabilities over phases organized around technical layers.**

This is a preference, not a hard rule. When building new features, prefer phases that deliver a complete callable increment — schema through component for one capability. When fixing bugs, refactoring, or addressing cross-cutting concerns (security hardening, performance, deprecation sweeps across surface area), organize by concern instead. Label every phase as one of: Feature, Foundation, or Cross-cutting.

```
Phase 0: Foundation      [Foundation]     → shared infra, no testable endpoint yet
Phase 1: Auth            [Feature]        → POST /auth/login callable after this phase
Phase 2: Content         [Feature]        → GET/POST /content callable after this phase
Phase 3: Fix N+1 Queries [Cross-cutting]  → correctness across 4 services, no new endpoint
```

Before writing the phase structure, ask for each Feature phase: "What can the test skill call after this phase completes?" If nothing, check whether the consumer sections are missing. For Cross-cutting phases, the check doesn't apply — document the concern and affected surface area instead.

Plans can be large with many tasks — this principle restructures phase groupings, not plan size.

### Steps

1. Read `{PLAN_ROOT}/spec/universal-spec.md`
2. Write intake manifest to `{PLAN_ROOT}/agent-outputs/planner/00_intake_manifest.md`
3. Generate `AGENT_SYSTEM.md` at `{PLAN_ROOT}/AGENT_SYSTEM.md` (see §AGENT_SYSTEM.md below)
4. Write phase structure to `{PLAN_ROOT}/agent-outputs/planner/01_phase_structure.md` — verify each phase after Phase 0 has a declared testable outcome
5. For each section in the spec, **one at a time:**
   a. Select agent from the routing table below
   b. Build task description using the 7-section template (see §Task Description)
   c. Extract `--files-expected` from File Manifest
   d. Register with `node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts create` (builder task first)
   e. Create paired reviewer task immediately after
6. Set dependencies via `node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts update --add-blocked-by`
7. Write plan file to `{PLAN_ROOT}/{plan-name}.md`

### Agent Routing

| Layer | Builder Agent | Reviewer Agent |
|---|---|---|
| schema / contract | builder | reviewer |
| service / infra | builder | reviewer |
| route | builder | reviewer |
| hook / component | builder | reviewer |
| config | builder | reviewer |
| architecture audit | architecture | reviewer |
| test | tester | reviewer |
| test-assess | test-creator | reviewer |
| live | live-runner | reviewer |
| audit | silent-failure-hunter / log-auditor | reviewer |

### Task Description: 7 Required Sections

Every task description must contain all 7 sections. Minimum 800 characters. Shorter = not self-contained.

```
## READ FIRST
- {PLAN_ROOT}/AGENT_SYSTEM.md
- {PLAN_ROOT}/spec/universal-spec.md §{N}
- [prior builder outputs if this task depends on one]

## CURRENT STATE
Phase {N} of {total}. [What prior tasks established that this task depends on.]
[Files that exist. Functions already defined. State of the system entering this task.]

## WORK ITEMS
1. [Exact action from spec — file path, function name, what to create/change]
2. [Exact action]
3. [...]

## ACCEPTANCE CRITERIA
- [ ] [Must-pass condition — grep-verifiable or test-verifiable]
- [ ] [...]

## VERIFICATION
```bash
[Exact command to verify this task is complete]
```

## OUTPUT LOCATION
{PLAN_ROOT}/agent-outputs/{task-id}/
- build-summary.md (required)
- notes.md (for TDD/spec drift)

## TASK MANAGEMENT
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts get --plan {plan-name} --task-id {task-id}
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts start --plan {plan-name} --task-id {task-id} --caller builder
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-read --plan {plan-name} --task-id {task-id} --path "{PLAN_ROOT}/AGENT_SYSTEM.md" [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-mutation --plan {plan-name} --task-id {task-id} --path "src/path/to/file.ts" [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts complete --plan {plan-name} --task-id {task-id} --caller builder --discovered-context-file {PLAN_ROOT}/agent-outputs/{task-id}/discovered-context.json --self-audit-file {PLAN_ROOT}/agent-outputs/{task-id}/self-audit.json
```

### tasks.ts create Call Pattern

**Builder tasks:**
```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts create \
  --plan {plan-name} \
  --task-id {task-id} \
  --subject "{task name}" \
  --description "{filled 7-section template}" \
  --active-form "{present continuous verb phrase}" \
  --assigned-to builder \
  --layer {schema|service|route|component|hook|config|test|test-assess|live|audit|infra|contract} \
  --required-reads "{PLAN_ROOT}/AGENT_SYSTEM.md" \
  --required-reads "{PLAN_ROOT}/spec/universal-spec.md" \
  --files-expected '{"path":"src/path/to/file.ts","op":"create","symbolsRequired":["fnName"]}' \
  --files-expected '{"path":"src/other/file.ts","op":"modify","symbolsRequired":["methodName"]}'
```

**Reviewer tasks:**
```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts create \
  --plan {plan-name} \
  --task-id {task-id} \
  --subject "Review: {builder task name}" \
  --description "{reviewer 7-section template}" \
  --active-form "reviewing {what builder built}" \
  --assigned-to reviewer \
  --layer {same as builder} \
  --required-reads "{PLAN_ROOT}/AGENT_SYSTEM.md" \
  --required-reads "{PLAN_ROOT}/spec/universal-spec.md" \
  --required-reads "{PLAN_ROOT}/agent-outputs/{builder-task-id}/build-summary.md" \
  --files-expected '{"path":"{PLAN_ROOT}/agent-outputs/{reviewer-task-id}/review-report.md","op":"create","symbolsRequired":["STATUS:"]}'
```

`--files-expected` is mandatory on every task. Max 3 files per task — split if more.

### AGENT_SYSTEM.md Structure

Every plan requires one AGENT_SYSTEM.md. Every agent reads it first.

```markdown
# Agent System Context — {Plan Name}

## Paths
| Key | Value |
|-----|-------|
| CODEBASE_PATH | the current working directory; never typed into a file or command |
| AGENT_ROOT | .agents |
| PLAN_ROOT | {AGENT_ROOT}/runs/{plan-name} |
| CODEX_AGENT_ROOT | unset; the root is the current directory |

All agent output files live under PLAN_ROOT. All tasks.ts calls run from the codebase root with no root prefix.

## Agent Lifecycle
When your managed task is done or blocked, complete the task/runtime write first, then end your final response with:
`ORCHESTRATOR_SIGNAL: DONE task={task-id-or-role} status={COMPLETE|PASS|FAIL|BLOCKED|ISSUES_FOUND|CLEAN} output={primary-output-path-or-none} next={continue|needs_revision|blocked|triage|retry}`

## System Identity
{What the system is, what it does, who uses it, what it cannot do}

## Architecture Context
{Patterns, conventions, and WHY — enough for an agent to make judgment calls without guessing}

### Mandatory Patterns
| Pattern | Where to learn it | Rule |

## Constraints
### Hard Constraints
### Security Rules
### Anti-Requirements

## The Authoritative Blueprint
`{PLAN_ROOT}/spec/universal-spec.md`

## Before Writing Any Code — Read These
| File | Why |

## Task Management
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts get --plan {plan-name} --task-id {task-id}
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-read --plan {plan-name} --task-id {task-id} --path "{PLAN_ROOT}/AGENT_SYSTEM.md" [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts log-mutation --plan {plan-name} --task-id {task-id} --path "<path>" [<path> ...]
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts complete --plan {plan-name} --task-id {task-id} --caller builder \
  --discovered-context-file {PLAN_ROOT}/agent-outputs/{task-id}/discovered-context.json \
  --self-audit-file {PLAN_ROOT}/agent-outputs/{task-id}/self-audit.json

## Dev Environment
{Ports, env vars, cache commands, gotchas}
```

---

## Command: execute

**Invocation:** `/task-orchestration execute <plan-name>`

Dispatches agents to run tasks in phase order. Monitors progress. Gates on reviewer verdicts.

### Agent Lifecycle Contract

This applies to every spawned builder, reviewer, auditor, tester, resolver, triage, and one-off helper agent.

**Spawn prompt requirement:** include this completion instruction inside the agent's Constraints section:

```
Before your final response, finish all required task/runtime writes. Your final response must end with exactly one line:
ORCHESTRATOR_SIGNAL: DONE task={task-id-or-role} status={COMPLETE|PASS|FAIL|BLOCKED|ISSUES_FOUND|CLEAN} output={primary-output-path-or-none} next={continue|needs_revision|blocked|triage|retry}
```

**Parent responsibility:** after every `wait_agent` result:

1. Read the final response and primary output path named in `ORCHESTRATOR_SIGNAL`.
2. Re-check `task-orchestration-runner.ts next-actions` or the relevant report file before advancing.
3. If the child has no immediate follow-up question, call `close_agent` on that child agent. Do this for PASS, FAIL, BLOCKED, and ISSUES_FOUND outcomes after the result has been captured.
4. If a child times out or does not emit `ORCHESTRATOR_SIGNAL`, inspect task state and output files, then either send one corrective message or close the child and respawn a replacement. Do not leave idle completed agents open.
5. Continue the orchestration loop immediately after all completed children in the current wave are consumed and closed.

`tasks.ts complete` and report files remain the source of truth. `ORCHESTRATOR_SIGNAL` is only the wake-up handshake that tells the parent to consume outputs, close the child, and continue.
If a subagent's own instructions require a specific status block, append `ORCHESTRATOR_SIGNAL` after that block. The signal is parent-control metadata, not part of the task report.
Never name an agent output file `report.md`, `findings.md`, `summary.md`, or `analysis.md` (in any letter case). Claude Code refuses subagent writes to those exact file names. Reviewer decisions use `review-report.md`. If a subagent's write is still refused, the subagent returns the full file content in its final response, and the parent writes it to the expected path unchanged before running `tasks.ts complete`.

### Steps

1. Read `{PLAN_ROOT}/{plan-name}.md`
2. Run `node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts list --plan {plan-name}` to see current status
2.5. **Managed execution contract**

Before dispatching any agent, materialize the execute supervisor and the active managed-plan marker:

```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/task-orchestration-runner.ts materialize \
  --plan-name {plan-name} \
  --plan-root .agents/runs/{plan-name} \
  --stage execute
```

From this point on, execution order is driven by:

```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/task-orchestration-runner.ts next-actions \
  --plan-name {plan-name} \
  --plan-root .agents/runs/{plan-name}
```

Interpret `next-actions` exactly:

| state | Meaning | Action |
|---|---|---|
| `dispatch-builders` | Runnable non-review tasks exist | Spawn every listed builder task in parallel |
| `dispatch-reviewers` | Runnable reviewer tasks exist | Spawn every listed reviewer task in parallel |
| `dispatch-triage` | Runnable debt-triage task exists | Spawn the listed debt-triage task |
| `needs_revision` | One or more tasks are `needs_revision` | Stop and surface the blocking review state |
| `waiting` | Tasks are `in_progress` | Wait; do not advance manually |
| `converged` | No unresolved work remains and triage is clean | Call `complete-execute-if-clean` |
| `blocked` | No runnable tasks, but convergence not reached | Stop and surface the deadlock |

3. For each phase:
   a. Run `task-orchestration-runner.ts next-actions`.
   b. If state=`dispatch-builders`, **spawn all listed builder tasks in a single message** (parallel Agent calls)
   c. Wait for all builders to complete. For each completed builder, read `ORCHESTRATOR_SIGNAL`, verify its output, then close the child agent. Re-check via `task-orchestration-runner.ts next-actions`.
   d. If state=`dispatch-reviewers`, **spawn all listed paired reviewer tasks in a single message** (parallel)
   e. Wait for reviewers. For each completed reviewer, read `ORCHESTRATOR_SIGNAL`, verify the report path, then close the child agent. Re-check via `task-orchestration-runner.ts next-actions` and read each `review-report.md`.
   f. If state=`needs_revision` or any reviewer STATUS: FAIL → stop, report failures, wait for user direction
   g. **Audit sub-pipeline** (conditional — runs after all reviewers pass, before testing):
      - If any `layer:audit` tasks exist in this phase → spawn them in parallel
        - `silent-failure-hunter` — reads builder output, surfaces silent failures and swallowed errors
        - `log-auditor` — reads builder output, surfaces log context gaps and error response shape issues
        - ISSUES_FOUND does not block — findings feed notes; debt-triage decides NEW TASK or DEFER
        - Both agents are read-only; they never modify source
   h. **Testing sub-pipeline** (runs after all reviewers pass):
      - If `test-assess` task exists → spawn **test-creator** first
        - test-creator PASS → proceed to execution step
        - test-creator BLOCK → execute all `tc-*` gap tasks (builder writes tests), then retry test-creator
      - Execution step: spawn **tester** (layer:test tasks) OR **live-runner** (layer:live tasks)
        - PASS → advance to next phase
        - PARTIAL / FAIL → spawn **test-resolver** with reference to the tester/live-runner report
          - test-resolver RESOLVED → advance to next phase
          - test-resolver BLOCKED (source bug / infra / max iterations) → stop, report to user, wait for direction
        - BLOCKED (infra not running) → create infra-setup task, wait for user to start Docker, retry
   i. Run `task-orchestration-runner.ts next-actions` again.
      If state=`dispatch-triage`, **spawn the `debt-triage` agent.**
      Pass it: CODEBASE_PATH, AGENT_ROOT, PLAN_ROOT, the plan name, the phase number, and the output path for the triage report.
      The agent runs all tasks.ts calls from the codebase root with no root prefix.
      The agent runs `tasks.ts notes` itself, triages every signal, and creates any NEW TASK
      records before writing its report. It does not hand decisions back to the orchestrator.
   j. Wait for the triage report. Read `ORCHESTRATOR_SIGNAL`, read the report, then close the triage agent.
      If `Triage: BLOCKED` — stop, surface the escalation to the user, wait for direction.
      If NEW TASKs were created: execute them (steps a–g) before advancing.
      Proceed to next phase only when the triage report ends with `Triage: CLEAN`.
4. After all phases complete: spawn the `debt-triage` agent one final time for end-of-plan triage
   — agent resolves all remaining signals (DEFER or NEW TASK + execute) and runs static analysis (tsc + ESLint)
   — static analysis findings treated as signals: NEW TASK for fixable issues, DEFER for pre-existing
   — wait for final triage, read `ORCHESTRATOR_SIGNAL`, read the report, then close the triage agent
   — if `Triage: CLEAN`: done
   — if `Triage: BLOCKED`: surface escalation to user, wait for direction
5. Run:

```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/task-orchestration-runner.ts complete-execute-if-clean \
  --plan-name {plan-name} \
  --plan-root .agents/runs/{plan-name}
```

Only if that command succeeds is execution complete.
6. Write completion report

### Spawn Prompt Structure (all 5 sections required)

Every agent spawn must include:
1. **System Identity** — mental model of the agent's role, not the file tree
2. **Architecture Context** — patterns + WHY so agent never invents what already exists
3. **Constraints** — what cannot change, hard edges, and the `ORCHESTRATOR_SIGNAL` final-line requirement
4. **Current State** — what this session has learned, what prior agents did, what failed
5. **Context for Your Job** — why this task, what to build/review, what form the output takes

### Monitoring

```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts list --plan {plan-name}
```

### Blocking Conditions

| Condition | Action |
|---|---|
| Reviewer STATUS: FAIL | Stop phase, report findings, wait for user |
| Builder exceeded 3 files without split | Flag for replanning, do not continue || Expert reviewer REVIEW_BLOCK | Mark builder task `needs_revision`, surface review file, wait for user || test-creator BLOCK | Execute all `tc-*` gap tasks (builder writes missing tests), then retry test-creator |
| tester / live-runner FAIL or PARTIAL | Spawn test-resolver; only advance on RESOLVED |
| test-resolver BLOCKED (source bug) | Stop, report to user — source needs a builder fix before tests can pass |
| test-resolver BLOCKED (infra) | Stop, create infra-setup task, wait for user to resolve Docker/env issue |
| live-runner BLOCKED (Docker not running) | Stop, report infra requirement, wait for user direction |

---

## Output Destinations

Single source of truth — all plan files, task records, and agent outputs live under `.agents`:

```
{CODEBASE_PATH}/
└── .agents/
    ├── data/
    │   ├── tasks.db
    │   ├── audit.db
    └── runs/
        └── {plan-name}/                         ← PLAN_ROOT
        ├── AGENT_SYSTEM.md
        ├── {plan-name}.md
        ├── spec/
        │   └── universal-spec.md
        ├── task-list.json                       ← derived cache view synced from tasks.db
        └── agent-outputs/
            ├── planner/
            │   ├── 00_intake_manifest.md
            │   └── 01_phase_structure.md
            └── {task-id}/
                ├── build-summary.md
                └── notes.md
```

Task management CLI (run from the codebase root; no root prefix):
```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts <create|get|start|log-read|log-mutation|complete|update|list|notes|q|timeline|status>
```

---

## Agent Roster

| Agent | subagent_type | Reasoning | Role |
|---|---|---|---|
| builder | `builder` | medium | Executes ONE implementation task — writes/edits code |
| architecture | `architecture` | high | Audits codebase structure, produces spec sections |
| reviewer | `task-reviewer` | medium | Validates builder output against spec + principles — writes review-report.md to PLAN_ROOT/agent-outputs/{reviewer-task-id}/ |
| debt-triage | `debt-triage` | high | Reads accumulated notes signals, makes DEFER/NEW TASK/AMEND/ESCALATE decisions, creates tasks immediately, runs tsc + ESLint static analysis at end-of-plan, writes triage report |
| tester | `tester` | medium | Runs tests in one of 8 modes — unit, integration, system, contract, golden-master, ui, ux, scenario |
| test-creator | `test-creator` | high | Coverage evaluator — audits gap across all 8 modes, detects infra needs, self-registers `tc-*` gap tasks |
| live-runner | `live-runner` | medium | Docker Compose lifecycle — starts stack, runs system/integration tests, tears down |
| test-resolver | `test-resolver` | medium | Diagnoses and fixes failing test files (max 3 iterations); escalates BLOCKED on source bugs or infra issues |
| scenario-writer | `scenario-writer` | high | Writes `.scenario.md` files for ui/scenario tester modes |
| silent-failure-hunter | `silent-failure-hunter` | high | Read-only audit — surfaces empty catches, swallowed errors, fire-and-forget async; ISSUES_FOUND is non-blocking |
| log-auditor | `log-auditor` | high | Read-only audit — surfaces log context gaps and error response shape issues; ISSUES_FOUND is non-blocking |
