---
name: architecture
description: Full architecture audit. Six phases — inventory all building blocks in parallel, diagnose patterns, produce a gap analysis and remediation plan, run a holistic principles audit, convert findings to universal-spec.md. Outputs directly to /task-orchestration convert-to-tasks.
argument-hint: "<codebase-path> [feature-name]"
---

# Architecture Skill

Runtime contract:
- `.agents/contracts/architecture.manifest.json` is the authoritative phase graph.
- `.agents/scripts/architecture-runner.ts` materializes tasks, emits dispatch plans, tracks wave state, and reconciles artifacts.
- This skill defines intent and quality bars; the manifest and runner own execution state.
- The parent orchestrator owns spawned-agent lifecycle. Every architecture subagent prompt must require an `ORCHESTRATOR_SIGNAL` final line; after each wait, consume the output, verify the artifact, then close the child agent before advancing.

Six-phase orchestration. Each phase reads the previous phase's outputs and appends new ones to the audit tree. The orchestrator never reads template files — it passes paths and variables. Agents read their own templates and reference files.

Agent lifecycle rule for every spawn in this skill:

```
ORCHESTRATOR_SIGNAL: DONE task={phase-or-template-name} status={COMPLETE|BLOCKED|NEEDS_MORE_CONTEXT} output={primary-output-path} next={continue|blocked}
```

Treat that line as the wake-up handshake only. The JSONL/markdown artifact remains the source of truth. After consuming the signal and verifying the artifact, close the completed child agent.

**Phase 1** — 36 inventory agents across eight groups: structure, type system, observability, error handling, dependencies, patterns, frontend, and test architecture. Thirty-five run in parallel; `inventory-test-surface` runs after (depends on tests, entry-points, file-structure). Each writes a JSONL inventory with a `_summary` record.

**Phase 2** — 28 diagnose agents across eight categories. Twenty-seven run in parallel; type-dissolution runs after trace (its only dependency). Each reads inventory JSONL files and the codebase and writes a JSONL output with a `_summary` record.

**Phase 3** — Eight agents synthesize Phase 2 findings. Six run in parallel and produce `plan/synthesis-{category}.md`. A seventh produces `plan/ecosystem-handoff.json`. An eighth assembles all diagnose findings into structured JSONL issue records at `issues/issues.jsonl` — sorted by priority, enrichment-ready (product_impact and on_critical_journey are null until ecosystem fills them).

**Phase 4** — One principles-audit agent reads all prior outputs and verifies every principle was checked and every violation has a remediation item.

**Phase 4b** — One enrich-issues agent derives user journeys from the Phase 1 inventory (entry-points, frontend-components, internal-imports) and cross-references every issue record. Populates `product_impact` (one sentence: what breaks for the user) and `on_critical_journey` / `journey_name` (true if the affected file sits on a critical or primary user flow). Output: `issues/issues-enriched.jsonl`.

**Phase 5** — One convert-to-spec agent reads plan outputs and produces `universal-spec.md`.

Architecture audits and plans test work, but it does not execute builder, reviewer, audit, or test agents. Execution belongs to `/task-orchestration`, which consumes the resulting spec/tasks and runs builders, reviewers, conditional auditors, and the test pipeline.

---

## Reference Material

ADW reference files at `./.agents/skills/architecture/reference/`:

| File | Content |
|------|---------|
| `01-principle.md` | The meta-principle — agent-readability, the grep test |
| `02-building-blocks.md` | Types, Structures, Schemas, Interfaces, Classes, Enums |
| `03-observability.md` | Typed results, boundary printing, tracking messages, drillability |
| `04-diagnostics.md` | The diagnostic checks with procedures and output formats |
| `05-construction.md` | The construction steps — what correct looks like |
| `06-structure.md` | File size signals role, file naming verb-noun vs noun, structural anchors at root only, composition root vs barrel index |
| `final-spec-example.md` | Quality bar — annotated example of a complete audit + spec output |

Templates at `./.agents/skills/architecture/templates/`:

| Template | Phase | Group |
|----------|-------|-------|
| `inventory-enums.md` | 1 | structure |
| `inventory-classes.md` | 1 | structure |
| `inventory-structures.md` | 1 | structure |
| `inventory-schemas.md` | 1 | structure |
| `inventory-types.md` | 1 | structure |
| `inventory-interfaces.md` | 1 | structure |
| `inventory-entry-points.md` | 1 | structure |
| `inventory-folder-structure.md` | 1 | structure |
| `inventory-file-structure.md` | 1 | structure |
| `inventory-type-aliases.md` | 1 | type system |
| `inventory-type-dissolution.md` | 1 | type system |
| `inventory-type-operations.md` | 1 | type system |
| `inventory-result-types.md` | 1 | type system |
| `inventory-data-transfer-objects.md` | 1 | type system |
| `inventory-domain-models.md` | 1 | type system |
| `inventory-observability.md` | 1 | observability |
| `inventory-log-calls.md` | 1 | observability |
| `inventory-metric-emissions.md` | 1 | observability |
| `inventory-trace-spans.md` | 1 | observability |
| `inventory-error-types.md` | 1 | error handling |
| `inventory-error-reports.md` | 1 | error handling |
| `inventory-try-catch-flow.md` | 1 | error handling |
| `inventory-external-imports.md` | 1 | dependencies |
| `inventory-internal-imports.md` | 1 | dependencies |
| `inventory-magic-numbers.md` | 1 | patterns |
| `inventory-magic-strings.md` | 1 | patterns |
| `inventory-config.md` | 1 | patterns |
| `inventory-tests.md` | 1 | patterns |
| `inventory-state-shapes.md` | 1 | patterns |
| `inventory-event-shapes.md` | 1 | patterns |
| `inventory-feature-flags.md` | 1 | patterns |
| `inventory-frontend-components.md` | 1 | frontend |
| `inventory-frontend-hooks.md` | 1 | frontend |
| `inventory-frontend-state.md` | 1 | frontend |
| `inventory-frontend-render-boundaries.md` | 1 | frontend |
| `inventory-test-surface.md` | 1 | test arch (after wave) |
| `diagnose-grep-test.md` | 3 | vocabulary |
| `diagnose-variable-audit.md` | 3 | vocabulary |
| `diagnose-glossary-alignment.md` | 3 | vocabulary |
| `diagnose-trace.md` | 3 | type integrity |
| `diagnose-type-dissolution.md` | 3 | type integrity (after trace) |
| `diagnose-schema-derivation.md` | 3 | type integrity |
| `diagnose-boundary-completeness.md` | 3 | boundary |
| `diagnose-endpoint-drillability.md` | 3 | boundary |
| `diagnose-interface-gaps.md` | 3 | boundary |
| `diagnose-orchestration-seam.md` | 3 | boundary |
| `diagnose-external-boundary.md` | 3 | boundary |
| `diagnose-size-distribution.md` | 3 | structural |
| `diagnose-folder-organization.md` | 3 | structural |
| `diagnose-index-file-shape.md` | 3 | structural |
| `diagnose-naming-specificity.md` | 3 | structural |
| `diagnose-composition-root.md` | 3 | structural |
| `diagnose-scatter.md` | 3 | responsibility |
| `diagnose-dead-code.md` | 3 | coverage |
| `diagnose-decision-log.md` | 3 | coverage |
| `diagnose-frontend-prop-drilling.md` | 3 | frontend |
| `diagnose-frontend-render-boundary-correctness.md` | 3 | frontend |
| `diagnose-frontend-component-size-distribution.md` | 3 | frontend |
| `diagnose-frontend-dead-components.md` | 3 | frontend |
| `diagnose-test-architecture-tier-presence.md` | 3 | test arch |
| `diagnose-test-architecture-folder-mirror.md` | 3 | test arch |
| `diagnose-test-architecture-runner-coherence.md` | 3 | test arch |
| `diagnose-test-architecture-infrastructure-completeness.md` | 3 | test arch |
| `diagnose-test-architecture-mock-usage.md` | 3 | test arch |
| `diagnose-test-architecture-coverage-vs-journeys.md` | 3 | test arch |
| `diagnose-test-architecture-coverage-vs-mover.md` | 3 | test arch |
| `synthesize-vocabulary-type.md` | 4 | — |
| `synthesize-boundary.md` | 4 | — |
| `synthesize-structural.md` | 4 | — |
| `synthesize-coverage.md` | 4 | — |
| `synthesize-frontend.md` | 4 | — |
| `synthesize-test.md` | 4 | — |
| `ecosystem-handoff.md` | 4 | — |
| `adw-principles-audit.md` | 4 | — |
| `assemble-issues.md` | 3c | — |
| `enrich-issues.md` | 4b | — |

Command-style prompt shards at `./.agents/skills/architecture/commands/`:

| File | Purpose |
|------|---------|
| `types.md` | Type inventory/audit command prompt |
| `interfaces.md` | Interface inventory/audit command prompt |
| `schemas.md` / `schema.md` | Schema inventory/audit command prompt |
| `classes.md` | Class inventory/audit command prompt |
| `enums.md` | Enum inventory/audit command prompt |
| `entry-points.md` | Entry point inventory/audit command prompt |
| `folder-structure.md` / `structure.md` | Folder and structure inspection prompt |
| `grep-test.md` | Naming grep-test prompt |
| `trace.md` | Trace and dependency prompt |
| `dead-code.md` | Dead code inspection prompt |
| `observability.md` | Observability inspection prompt |
| `synthesize.md` | Synthesis prompt |
| `principles-audit.md` | Principles audit prompt |
| `convert-to-spec.md` | Universal spec conversion prompt |

---

## Arguments

```
$ARGUMENTS: <codebase-path> [feature-name]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
```

---

## Step 1 — Parse Arguments and Resolve Mode

Parse $ARGUMENTS as flexible natural language. Extract these variables in order:

### CODEBASE_PATH
Required. Must be an absolute path. Verify it exists:
```bash
ls "{CODEBASE_PATH}/src" 2>/dev/null || ls "{CODEBASE_PATH}" 2>/dev/null
```
If path does not exist: stop — `Architecture cannot start — path does not exist: {CODEBASE_PATH}`

### FEATURE_NAME and FEATURE_PATH
Optional. Defaults to `"full codebase"` / `null`.

Natural language patterns that indicate feature scope:
- "around the cache feature" → FEATURE_NAME=cache
- "isolate the theme settings feature" → FEATURE_NAME=theme-settings
- "just src/services/cache" → FEATURE_PATH=src/services/cache, FEATURE_NAME=cache
- "feature <name>" or "--feature <name>" → FEATURE_NAME=<name>

If FEATURE_NAME given but FEATURE_PATH null, attempt to derive:
```bash
find "{CODEBASE_PATH}/src" -type d -name "*{FEATURE_NAME}*" | head -3
```
Use first match as FEATURE_PATH if found. Otherwise FEATURE_PATH remains null.

### MODE
One of: `inventory | audit | spec`. Default: `audit`.

| Pattern | MODE |
|---------|------|
| "only inventory" / "just inventory" / "--inventory" / "--only-inventory" | inventory |
| "spec" / "convert to spec" / "--spec" / "universal spec" | spec |
| (no match / default) | audit |

### Derived variables
```
CODEBASE_NAME  — last path segment of CODEBASE_PATH
DATE_SLUG      — today's date: YYYY-MM-DD
FEATURE_SLUG   — FEATURE_NAME lowercase, spaces/underscores → hyphens
OUTPUT_DIR     — {CODEBASE_PATH}/.agents/runs/architecture/{DATE_SLUG}-{FEATURE_SLUG}/
INV_DIR        — {OUTPUT_DIR}/inventory
DIAGNOSE_DIR   — {OUTPUT_DIR}/diagnose
ISSUES_DIR     — {OUTPUT_DIR}/issues
REF_DIR        — ./.agents/skills/architecture/reference
TPL_DIR        — ./.agents/skills/architecture/templates
```

### Resolve CODEBASE_SLUG from audit.db
```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts codebases list
```
Find row where `path` matches CODEBASE_PATH or `name` matches CODEBASE_NAME. Store as CODEBASE_SLUG. If not found:
```bash
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts codebases add \
  --slug "{FEATURE_SLUG}-{CODEBASE_NAME}" \
  --name "{CODEBASE_NAME}" \
  --path "{CODEBASE_PATH}"
```

### Resolve GIT_SHA
```bash
git -C "{CODEBASE_PATH}" rev-parse HEAD 2>/dev/null || echo "no-git"
```

### Print resolved configuration
```
/architecture
Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}  ({FEATURE_PATH or "full codebase"})
Mode:      {MODE}
Output:    {OUTPUT_DIR}
Git SHA:   {GIT_SHA}

Phase 1  — Inventory   (36 agents — 35 parallel, test-surface after)
[if MODE != inventory:]
Phase 2  — Diagnose    (28 agents — 27 parallel, type-dissolution after trace)
Phase 3  — Synthesize  (6 category syntheses + ecosystem-handoff, parallel)
Phase 3c — Issues      (assemble-issues → issues/issues.jsonl)
Phase 4  — Audit       (principles-audit)
Phase 4b — Enrich      (enrich-issues → issues/issues-enriched.jsonl)
[if MODE == spec:]   Phase 5b — Spec       (convert-to-spec → universal-spec.md)
```

---

## Step 2 — Set Up Output Tree

```bash
mkdir -p "{OUTPUT_DIR}/inventory"
mkdir -p "{OUTPUT_DIR}/diagnose"
mkdir -p "{OUTPUT_DIR}/plan"
mkdir -p "{OUTPUT_DIR}/issues"
mkdir -p "{OUTPUT_DIR}/spec"
```

---

## Step 3 — Build CONTEXT_BLOCK

Read these files from the codebase (do not read template files — agents do that):
- `{CODEBASE_PATH}/package.json` (or equivalent) → tech stack, dependencies
- `{CODEBASE_PATH}/README.md` if present → what the app does
- `{CODEBASE_PATH}/src` directory listing → folder structure overview

Build the CONTEXT_BLOCK once. Every agent brief is this block plus a "## Context for Your Job" section specific to that agent.

```
## System Identity
{CODEBASE_NAME} is a {stack} application. {2-3 sentences: what it does, who uses it, what FEATURE_NAME is responsible for.}

## Architecture Context
Tech stack: {versions}. Key patterns: {how layers connect, naming conventions, module boundaries}.

## Constraints
Read-only on source — never write to {CODEBASE_PATH}. Write output only to {OUTPUT_DIR}/. All JSONL outputs must end with a _summary record where status="complete".

## Current State
{Phase-specific — updated per phase below. "No prior audit phases complete." for Phase 1.}
```

---

## Step 4 — Phase 1: Inventory

Spawn all 35 agents in a **single parallel call**. Each agent brief = CONTEXT_BLOCK + a "## Context for Your Job" section. The orchestrator does not read templates — agents read their own.

**Canonical brief format for all inventory agents:**

```
{CONTEXT_BLOCK with Current State = "Phase 1 inventory. No prior phases complete."}

## Context for Your Job
You are the {agent-name} inventory agent.

Read your task template: {TPL_DIR}/{template}.md
Substitute these values when executing the template:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  CODEBASE_NAME = {CODEBASE_NAME}
  OUTPUT_PATH   = {OUTPUT_DIR}/inventory/{output}.jsonl

Reference files to read before executing:
  {REF_DIR}/{ref-01}.md
  {REF_DIR}/{ref-02}.md
  ...

Execute the template exactly. Write output to OUTPUT_PATH. End with a _summary JSON line where status="complete".
```

**Group A — Structure (9 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-enums.md` | `inventory/enums.jsonl` | 01, 02, 04 |
| `inventory-classes.md` | `inventory/classes.jsonl` | 01, 02, 04 |
| `inventory-structures.md` | `inventory/structures.jsonl` | 01, 02 |
| `inventory-schemas.md` | `inventory/schemas.jsonl` | 01, 02 |
| `inventory-types.md` | `inventory/types.jsonl` | 01, 02 |
| `inventory-interfaces.md` | `inventory/interfaces.jsonl` | 01, 02 |
| `inventory-entry-points.md` | `inventory/entry-points.jsonl` | 01, 02, 03 |
| `inventory-folder-structure.md` | `inventory/folder-structure.jsonl` | 01, 06 |
| `inventory-file-structure.md` | `inventory/file-structure.jsonl` | 01, 06 |

**Group B — Type system (6 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-type-aliases.md` | `inventory/type-aliases.jsonl` | 01, 02 |
| `inventory-type-dissolution.md` | `inventory/type-dissolution.jsonl` | 01, 02, 04 |
| `inventory-type-operations.md` | `inventory/type-operations.jsonl` | 01, 02 |
| `inventory-result-types.md` | `inventory/result-types.jsonl` | 01, 02, 03 |
| `inventory-data-transfer-objects.md` | `inventory/data-transfer-objects.jsonl` | 01, 02 |
| `inventory-domain-models.md` | `inventory/domain-models.jsonl` | 01, 02 |

**Group C — Observability (4 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-observability.md` | `inventory/observability.jsonl` | 01, 03 |
| `inventory-log-calls.md` | `inventory/log-calls.jsonl` | 01, 03 |
| `inventory-metric-emissions.md` | `inventory/metric-emissions.jsonl` | 01, 03 |
| `inventory-trace-spans.md` | `inventory/trace-spans.jsonl` | 01, 03 |

**Group D — Error handling (3 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-error-types.md` | `inventory/error-types.jsonl` | 01, 02 |
| `inventory-error-reports.md` | `inventory/error-reports.jsonl` | 01, 02, 03 |
| `inventory-try-catch-flow.md` | `inventory/try-catch-flow.jsonl` | 01, 02 |

**Group E — Dependencies (2 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-external-imports.md` | `inventory/external-imports.jsonl` | 01, 02 |
| `inventory-internal-imports.md` | `inventory/internal-imports.jsonl` | 01, 02 |

**Group F — Patterns (7 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-magic-numbers.md` | `inventory/magic-numbers.jsonl` | 01, 02 |
| `inventory-magic-strings.md` | `inventory/magic-strings.jsonl` | 01, 02 |
| `inventory-config.md` | `inventory/config.jsonl` | 01, 02 |
| `inventory-tests.md` | `inventory/tests.jsonl` | 01, 02, 04 |
| `inventory-state-shapes.md` | `inventory/state-shapes.jsonl` | 01, 02 |
| `inventory-event-shapes.md` | `inventory/event-shapes.jsonl` | 01, 02 |
| `inventory-feature-flags.md` | `inventory/feature-flags.jsonl` | 01, 02 |

**Group G — Frontend (4 agents)**

| Template | Output | Reference files |
|----------|--------|----------------|
| `inventory-frontend-components.md` | `inventory/frontend-components.jsonl` | 01, 02, 06 |
| `inventory-frontend-hooks.md` | `inventory/frontend-hooks.jsonl` | 01, 02, 06 |
| `inventory-frontend-state.md` | `inventory/frontend-state.jsonl` | 01, 02 |
| `inventory-frontend-render-boundaries.md` | `inventory/frontend-render-boundaries.jsonl` | 01, 02, 06 |

Spawn all 35 `auditor` agents in a single parallel call. Wait for all 35. Verify each output: parse the last non-empty line as JSON — must have `"_summary":true` and `"status":"complete"`. If any returns `"status":"needs_more_context"`: surface the `reason`, stop.

**Group H — Test Architecture (1 agent, after parallel wave)**

`inventory-test-surface.md` depends on three outputs from the parallel wave. Spawn after all 35 complete.

Brief Context for Your Job:
```
You are the test-surface inventory agent.
Read your task template: {TPL_DIR}/inventory-test-surface.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  CODEBASE_NAME = {CODEBASE_NAME}
  OUTPUT_PATH   = {OUTPUT_DIR}/inventory/test-surface.jsonl
  PRIOR_FILE_1  = {OUTPUT_DIR}/inventory/tests.jsonl
  PRIOR_FILE_2  = {OUTPUT_DIR}/inventory/entry-points.jsonl
  PRIOR_FILE_3  = {OUTPUT_DIR}/inventory/file-structure.jsonl
  PRIOR_FILE_4  = {OUTPUT_DIR}/inventory/frontend-components.jsonl  (use [ -f ] guard — safe if absent)
Reference files to read: {REF_DIR}/01-principle.md, 02-building-blocks.md, 04-diagnostics.md
Execute the template exactly.
```

Wait. Verify output ends with `_summary` where `status="complete"`.

Print:
```
Phase 1 — Inventory complete (36 outputs)
  Structure:    enums · classes · structures · schemas · types · interfaces · entry-points · folder-structure · file-structure
  Type system:  type-aliases · type-dissolution · type-operations · result-types · data-transfer-objects · domain-models
  Observability: observability · log-calls · metric-emissions · trace-spans
  Errors:       error-types · error-reports · try-catch-flow
  Dependencies: external-imports · internal-imports
  Patterns:     magic-numbers · magic-strings · config · tests · state-shapes · event-shapes · feature-flags
  Frontend:     frontend-components · frontend-hooks · frontend-state · frontend-render-boundaries
  Test arch:    test-surface
```

### Mode check
If MODE is `inventory`: skip to Step 8 (Report).

---

## Step 5 — Phase 2: Diagnose

Update Current State in CONTEXT_BLOCK:
```
Phase 1 complete. All 36 inventory files at {OUTPUT_DIR}/inventory/.
```

Spawn all 27 agents in a **single parallel call**. One exception: `diagnose-type-dissolution` depends on `diagnose-trace` — it runs in Sub-wave B after.

**Canonical brief format for all diagnose agents:**

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the {agent-name} diagnostic agent.

Read your task template: {TPL_DIR}/{template}.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  CODEBASE_NAME = {CODEBASE_NAME}
  INV_DIR       = {OUTPUT_DIR}/inventory
  OUTPUT_PATH   = {OUTPUT_DIR}/diagnose/{output}.jsonl
  [PRIOR_FILE_N = {OUTPUT_DIR}/inventory/{file}.jsonl  — only for agents listed below]

Reference files to read: {REF_DIR}/{refs}.md
Execute the template exactly. End with a _summary JSON line where status="complete".
```

**Sub-wave A — 27 parallel agents**

| Template | Output | PRIOR_FILE substitutions | Refs |
|----------|--------|--------------------------|------|
| `diagnose-grep-test.md` | `diagnose/grep-test.jsonl` | — | 01, 02, 04 |
| `diagnose-variable-audit.md` | `diagnose/variable-audit.jsonl` | — | 01, 02, 04 |
| `diagnose-glossary-alignment.md` | `diagnose/glossary-alignment.jsonl` | — | 01, 02 |
| `diagnose-trace.md` | `diagnose/trace.jsonl` | — | 01, 02, 04 |
| `diagnose-schema-derivation.md` | `diagnose/schema-derivation.jsonl` | — | 01, 02 |
| `diagnose-boundary-completeness.md` | `diagnose/boundary-completeness.jsonl` | — | 01, 02, 03 |
| `diagnose-endpoint-drillability.md` | `diagnose/endpoint-drillability.jsonl` | PRIOR_FILE_1=inventory/entry-points.jsonl | 01, 03 |
| `diagnose-interface-gaps.md` | `diagnose/interface-gaps.jsonl` | PRIOR_FILE_1=inventory/interfaces.jsonl, PRIOR_FILE_2=inventory/classes.jsonl | 01, 02 |
| `diagnose-orchestration-seam.md` | `diagnose/orchestration-seam.jsonl` | — | 01, 02, 03 |
| `diagnose-external-boundary.md` | `diagnose/external-boundary.jsonl` | — | 01, 02, 03 |
| `diagnose-size-distribution.md` | `diagnose/size-distribution.jsonl` | — | 01, 06 |
| `diagnose-folder-organization.md` | `diagnose/folder-organization.jsonl` | — | 01, 06 |
| `diagnose-index-file-shape.md` | `diagnose/index-file-shape.jsonl` | — | 01, 06 |
| `diagnose-naming-specificity.md` | `diagnose/naming-specificity.jsonl` | — | 01, 06 |
| `diagnose-composition-root.md` | `diagnose/composition-root.jsonl` | — | 01, 06 |
| `diagnose-scatter.md` | `diagnose/responsibility-scatter.jsonl` | — | 01, 02, 04 |
| `diagnose-dead-code.md` | `diagnose/dead-code.jsonl` | — | 01, 02, 04 |
| `diagnose-decision-log.md` | `diagnose/decision-log.jsonl` | — | 01 |
| `diagnose-frontend-prop-drilling.md` | `diagnose/frontend-prop-drilling.jsonl` | PRIOR_FILE_1=inventory/frontend-components.jsonl | 01, 02, 04 |
| `diagnose-frontend-render-boundary-correctness.md` | `diagnose/frontend-render-boundary-correctness.jsonl` | PRIOR_FILE_1=inventory/frontend-render-boundaries.jsonl, PRIOR_FILE_2=inventory/frontend-components.jsonl | 01, 02, 04 |
| `diagnose-frontend-component-size-distribution.md` | `diagnose/frontend-component-size-distribution.jsonl` | PRIOR_FILE_1=inventory/frontend-components.jsonl | 01, 02, 06 |
| `diagnose-frontend-dead-components.md` | `diagnose/frontend-dead-components.jsonl` | PRIOR_FILE_1=inventory/frontend-components.jsonl | 01, 02, 04 |
| `diagnose-test-architecture-tier-presence.md` | `diagnose/test-architecture-tier-presence.jsonl` | PRIOR_FILE_1=inventory/tests.jsonl | 01, 02, 04 |
| `diagnose-test-architecture-folder-mirror.md` | `diagnose/test-architecture-folder-mirror.jsonl` | PRIOR_FILE_1=inventory/tests.jsonl, PRIOR_FILE_2=inventory/file-structure.jsonl | 01, 02, 04 |
| `diagnose-test-architecture-runner-coherence.md` | `diagnose/test-architecture-runner-coherence.jsonl` | PRIOR_FILE_1=inventory/tests.jsonl | 01, 02 |
| `diagnose-test-architecture-infrastructure-completeness.md` | `diagnose/test-architecture-infrastructure-completeness.jsonl` | PRIOR_FILE_1=inventory/tests.jsonl | 01, 02 |
| `diagnose-test-architecture-mock-usage.md` | `diagnose/test-architecture-mock-usage.jsonl` | PRIOR_FILE_1=inventory/tests.jsonl | 01, 02, 04 |
| `diagnose-test-architecture-coverage-vs-journeys.md` | `diagnose/test-architecture-coverage-vs-journeys.jsonl` | PRIOR_FILE_1=inventory/test-surface.jsonl | 01, 02, 04 |
| `diagnose-test-architecture-coverage-vs-mover.md` | `diagnose/test-architecture-coverage-vs-mover.jsonl` | PRIOR_FILE_1=inventory/test-surface.jsonl | 01, 02, 04 |

Wait for all 27. Verify each output ends with `_summary` where `status="complete"`.

**Sub-wave B — type-dissolution (after trace completes)**

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the type-dissolution diagnostic agent. This runs after diagnose-trace because it consumes trace output.

Read your task template: {TPL_DIR}/diagnose-type-dissolution.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  INV_DIR       = {OUTPUT_DIR}/inventory
  OUTPUT_PATH   = {OUTPUT_DIR}/diagnose/type-dissolution.jsonl
  PRIOR_FILE_1  = {OUTPUT_DIR}/diagnose/trace.jsonl
Reference files to read: {REF_DIR}/01-principle.md, 02-building-blocks.md, 04-diagnostics.md
Execute the template exactly.
```

Wait. Verify output ends with `_summary` where `status="complete"`.

Print:
```
Phase 2 — Diagnose complete (28 outputs across 8 categories)
  Vocabulary:    grep-test · variable-audit · glossary-alignment
  Type integrity: trace · type-dissolution · schema-derivation
  Boundary:      boundary-completeness · endpoint-drillability · interface-gaps · orchestration-seam · external-boundary
  Structure:     size-distribution · folder-organization · index-file-shape · naming-specificity · composition-root
  Responsibility: responsibility-scatter
  Coverage:      dead-code · decision-log
  Frontend:      frontend-prop-drilling · frontend-render-boundary-correctness · frontend-component-size-distribution · frontend-dead-components
  Test arch:     tier-presence · folder-mirror · runner-coherence · infrastructure-completeness · mock-usage · coverage-vs-journeys · coverage-vs-mover
```

---

## Step 6 — Phase 3: Synthesize

Update Current State in CONTEXT_BLOCK:
```
Phases 1–2 complete. All 28 diagnose files at {OUTPUT_DIR}/diagnose/.
```

**Sub-wave A — 6 parallel synthesis agents**

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the {category} synthesis agent.

Read your task template: {TPL_DIR}/{template}.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  OUTPUT_PATH   = {OUTPUT_DIR}/plan/{output}.md
  [PRIOR_FILE_N = {OUTPUT_DIR}/diagnose/{file}.jsonl — listed per agent below]
Reference files to read: {REF_DIR}/01-principle.md, 02-building-blocks.md, 03-observability.md, 05-construction.md
Execute the template exactly. End with: Status: COMPLETE
```

| Template | Output | PRIOR_FILE inputs (in order) |
|----------|--------|------------------------------|
| `synthesize-vocabulary-type.md` | `plan/synthesis-vocabulary-type.md` | diagnose/grep-test.jsonl, variable-audit.jsonl, glossary-alignment.jsonl, trace.jsonl, type-dissolution.jsonl, schema-derivation.jsonl |
| `synthesize-boundary.md` | `plan/synthesis-boundary.md` | diagnose/boundary-completeness.jsonl, endpoint-drillability.jsonl, interface-gaps.jsonl, orchestration-seam.jsonl, external-boundary.jsonl |
| `synthesize-structural.md` | `plan/synthesis-structural.md` | diagnose/size-distribution.jsonl, folder-organization.jsonl, index-file-shape.jsonl, naming-specificity.jsonl, composition-root.jsonl, responsibility-scatter.jsonl |
| `synthesize-coverage.md` | `plan/synthesis-coverage.md` | diagnose/dead-code.jsonl, decision-log.jsonl |
| `synthesize-frontend.md` | `plan/synthesis-frontend.md` | diagnose/frontend-prop-drilling.jsonl, frontend-render-boundary-correctness.jsonl, frontend-component-size-distribution.jsonl, frontend-dead-components.jsonl |
| `synthesize-test.md` | `plan/synthesis-test.md` | diagnose/test-architecture-tier-presence.jsonl, test-architecture-folder-mirror.jsonl, test-architecture-runner-coherence.jsonl, test-architecture-infrastructure-completeness.jsonl, test-architecture-mock-usage.jsonl, test-architecture-coverage-vs-journeys.jsonl, test-architecture-coverage-vs-mover.jsonl |

Spawn all 6 in a single parallel call. Wait. Verify each ends with `Status: COMPLETE`.

**Sub-wave B — ecosystem-handoff (after 6 syntheses complete)**

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the ecosystem-handoff agent. Writes audit metadata for downstream skills.

Read your task template: {TPL_DIR}/ecosystem-handoff.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  CODEBASE_NAME = {CODEBASE_NAME}
  FEATURE_NAME  = {FEATURE_NAME}
  DATE_SLUG     = {DATE_SLUG}
  OUTPUT_DIR    = {OUTPUT_DIR}
  OUTPUT_PATH   = {OUTPUT_DIR}/plan/ecosystem-handoff.json
Execute the template exactly. End with: Status: COMPLETE
```

Wait. Verify ends with `Status: COMPLETE`.

**Sub-wave C — assemble-issues (after ecosystem-handoff completes)**

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the issues assembly agent. Convert all diagnose findings into structured, enrichment-ready issue records.

Read your task template: {TPL_DIR}/assemble-issues.md
Substitute:
  CODEBASE_PATH = {CODEBASE_PATH}
  FEATURE_NAME  = {FEATURE_NAME}
  DIAGNOSE_DIR  = {OUTPUT_DIR}/diagnose
  ISSUES_DIR    = {OUTPUT_DIR}/issues
  OUTPUT_PATH   = {OUTPUT_DIR}/issues/issues.jsonl
Execute the template exactly. End with: Status: COMPLETE
```

Wait. Verify `{OUTPUT_DIR}/issues/issues.jsonl` exists and its last non-empty line parses as JSON with `"_summary":true` and `"status":"complete"`.

Print:
```
Phase 3 — Synthesize complete (8 outputs)
  Vocabulary + Type:  plan/synthesis-vocabulary-type.md
  Boundary:           plan/synthesis-boundary.md
  Structural:         plan/synthesis-structural.md
  Coverage:           plan/synthesis-coverage.md
  Frontend:           plan/synthesis-frontend.md
  Test architecture:  plan/synthesis-test.md
  Ecosystem handoff:  plan/ecosystem-handoff.json
  Issues:             issues/issues.jsonl  (+ issues/issues-{category}.jsonl ×6)
```

---

## Step 7 — Phase 4: Principles Audit

Update Current State in CONTEXT_BLOCK:
```
Phases 1–3 complete. All diagnose files at {OUTPUT_DIR}/diagnose/. All synthesis files at {OUTPUT_DIR}/plan/.
```

Spawn one `architecture-auditor` agent:

```
{CONTEXT_BLOCK}

## Context for Your Job
You are the principles auditor. Verify every ADW principle was checked, every finding was translated to a remediation item, and every CRITICAL/MAJOR violation has a do-first marker.

Read your task template: {TPL_DIR}/adw-principles-audit.md
Substitute:
  CODEBASE_PATH   = {CODEBASE_PATH}
  FEATURE_NAME    = {FEATURE_NAME}
  OUTPUT_PATH     = {OUTPUT_DIR}/plan/principles-audit.md

All 28 diagnose files are at {OUTPUT_DIR}/diagnose/ — the template lists which to read.
All 6 synthesis files are at {OUTPUT_DIR}/plan/ — the template lists which to read.
Reference files to read: {REF_DIR}/01-principle.md through 05-construction.md (all five).
Execute the template exactly. End with: Status: COMPLETE
```

Wait. Verify ends with `Status: COMPLETE`.

Print: `Phase 4 — Principles audit complete → principles-audit.md`

---

## Step 7b — Phase 4b: Enrich Issues

Spawn one `architecture-auditor` agent. This runs unconditionally (all modes except inventory).

```
{CONTEXT_BLOCK}

## Context for Your Job
You are enriching issue records with product impact context. You will derive user journeys from the inventory files already produced by Phase 1, then cross-reference every issue against those journeys.

Read your task template: {TPL_DIR}/enrich-issues.md
Substitute:
  CODEBASE_PATH    = {CODEBASE_PATH}
  FEATURE_NAME     = {FEATURE_NAME}
  INV_DIR          = {OUTPUT_DIR}/inventory
  ISSUES_DIR       = {OUTPUT_DIR}/issues
  ISSUES_PATH      = {OUTPUT_DIR}/issues/issues.jsonl
  JOURNEY_MAP_PATH = (omit — derive from INV_DIR)
  OUTPUT_PATH      = {OUTPUT_DIR}/issues/issues-enriched.jsonl
Execute the template exactly. End with: Status: COMPLETE
```

Wait. Verify `{OUTPUT_DIR}/issues/issues-enriched.jsonl` ends with `Status: COMPLETE`.

Print: `Phase 4b — Issues enriched → issues/issues-enriched.jsonl`

### Mode branch
- MODE is `audit`: skip to Step 8 (Final Review).
- MODE is `spec`: execute Step 9 (Phase 5b), then Step 8.

---

## Step 8 — Final Review

Read these outputs:
```
{OUTPUT_DIR}/plan/synthesis-vocabulary-type.md  ← extract _summary (findings_total, remediation_items)
{OUTPUT_DIR}/plan/synthesis-boundary.md
{OUTPUT_DIR}/plan/synthesis-structural.md
{OUTPUT_DIR}/plan/synthesis-coverage.md
{OUTPUT_DIR}/plan/synthesis-frontend.md         ← may be empty on non-frontend
{OUTPUT_DIR}/plan/synthesis-test.md
{OUTPUT_DIR}/plan/principles-audit.md           ← extract Final Verdict
```

Check against the quality bar at `{REF_DIR}/final-spec-example.md`:
1. Do synthesis files have specific remediation items — each with file:line, exact action, acceptance criterion?
2. Does principles-audit return COMPLETE verdict (≥90% COVERED/CLEAN)?
3. Are there FINDING_MISSING items — violations found but not in the remediation plan?
4. Are CRITICAL items (unguarded entry points, type dissolution at boundaries) marked as do-first?

Flag failures as `REVIEW NEEDED: {specific gap}`. Do not block — surface in report and let convert-to-spec proceed.

---

## Step 9 — Phase 5b: Convert to Spec (MODE=spec only)

```
{CONTEXT_BLOCK with Current State = "All 4 audit phases complete. Six synthesis files contain the prioritized remediation plan. principles-audit.md contains the coverage verdict."}

## Context for Your Job
You are converting a completed architecture audit into a Universal Spec for task-orchestration.

All output files follow these path conventions:
- Inventory: {OUTPUT_DIR}/inventory/{name}.jsonl
- Diagnose: {OUTPUT_DIR}/diagnose/{name}.jsonl
- Plan synthesis: {OUTPUT_DIR}/plan/synthesis-{category}.md
- Principles audit: {OUTPUT_DIR}/plan/principles-audit.md

Read these files to build the spec:
- {OUTPUT_DIR}/plan/synthesis-vocabulary-type.md
- {OUTPUT_DIR}/plan/synthesis-boundary.md
- {OUTPUT_DIR}/plan/synthesis-structural.md
- {OUTPUT_DIR}/plan/synthesis-coverage.md
- {OUTPUT_DIR}/plan/synthesis-frontend.md (if exists)
- {OUTPUT_DIR}/plan/synthesis-test.md
- {OUTPUT_DIR}/plan/principles-audit.md
- Relevant diagnose JSONL files for file:line violation details

Also read: {REF_DIR}/final-spec-example.md for the quality bar.
Also read: ./.agents/contracts/universal-spec-schema.md for the output format.

Write output to: {OUTPUT_DIR}/spec/universal-spec.md

Mapping rules:
- Every CRITICAL and MAJOR violation from synthesis files becomes a spec section
- Each section maps to ≤3 rows (split if a remediation item touches more files)
- Phase assignment follows the remediation plan's execution order
- Acceptance criteria must be grep-verifiable or compile-verifiable
- Every work item must name exact file path, exact function/symbol, exact operation

Quality gate before writing:
- [ ] Every CRITICAL item from principles-audit is a Phase 1 section
- [ ] Every section has a layer label (schema|service|route|component|hook|config|test-assess|test|live|audit|infra|contract)
- [ ] No section has >3 rows
- [ ] Phase 1 sections have zero dependencies
- [ ] Constraints §5 is populated from synthesis violations + principles-audit hard constraints

End with: Status: COMPLETE
```

Spawn one `architecture-auditor` agent. Wait. Verify `universal-spec.md` ends with `Status: COMPLETE`.

Print: `Phase 5b — Spec complete → universal-spec.md`

---

## Step 10 — Report

```
Architecture Audit Complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_DIR}

Phase 1 — Inventory:   36 files written
Phase 2 — Diagnose:    28 files written across 8 categories
Phase 3 — Synthesize:  synthesis-vocabulary-type.md · synthesis-boundary.md · synthesis-structural.md · synthesis-coverage.md · synthesis-frontend.md · synthesis-test.md · ecosystem-handoff.json
Phase 3c — Issues:     issues/issues.jsonl  (N total: C CRITICAL, M MAJOR, O MINOR, P NOTE)
Phase 4 — Audit:       principles-audit.md
Phase 4b — Enriched:   issues/issues-enriched.jsonl  (N on critical journeys)
[Phase 5 — Spec:       universal-spec.md]

[Synthesis Summary: N total findings — findings_total + remediation_items per synthesis file]
[Final Verdict from principles-audit.md]

Review flags: {N} (or "none")
{list any REVIEW NEEDED items}

Next:
  /ecosystem {CODEBASE_PATH} — enrich issues with product_impact + on_critical_journey
  /task-orchestration convert-to-tasks {plan-name}
  (spec lives at {OUTPUT_DIR}/spec/universal-spec.md)
```

If any phase was blocked: report `BLOCKED — {agent} — {output file}` instead of complete.
