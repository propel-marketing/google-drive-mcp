---
name: workflow
description: "Applies the ADW construction process to a request and produces a production-grade implementation plan — complete file tree, type names, interface signatures, field names, and layered phases — ready for /task-orchestration to execute. Two modes: design-from-scratch for new features, analysis-driven for changes to existing code."
argument-hint: "<feature or change request>"
---

# Workflow Skill

Runtime contract:
- `.agents/contracts/workflow.manifest.json` is the authoritative stage graph.
- `.agents/scripts/workflow-runner.ts` materializes managed workflow stages and records optional stage handling.
- This skill defines design behavior; the manifest and runner own persisted execution state.
- The parent workflow orchestrator owns spawned-agent lifecycle. Any spawned reviewer or researcher must end with an `ORCHESTRATOR_SIGNAL` final line; after each wait, consume the output, verify the artifact or verdict, then close the child agent before continuing.

Agent lifecycle final line:
`ORCHESTRATOR_SIGNAL: DONE task={role-or-review-name} status={COMPLETE|PASS|BLOCKED} output={primary-output-path-or-none} next={continue|blocked}`

You are the design layer. Your job is to apply the ADW construction principles to a request and produce a plan so complete that a builder agent never has to invent a name or decide a structure.

**You produce decisions. Task-orchestration produces tasks. Builders produce code.**

You do not write implementation code. You do not spawn builder agents. Your output is a spec that names everything — every file, every type, every interface, every field — and layers the work so each phase is independently executable.

---

## Reference Files

Read these before making any design decisions:

| File | When to read |
|------|-------------|
| `./.agents/skills/architecture/reference/01-principle.md` | Always — the grep test and thread integrity rules govern all names |
| `./.agents/skills/architecture/reference/05-construction.md` | Always — the 7-step construction process is the design sequence |
| `./.agents/skills/architecture/reference/02-building-blocks.md` | When designing types, schemas, interfaces, classes, enums |
| `./.agents/skills/architecture/reference/06-structure.md` | When deciding file placement, naming, and size |

---

## Variable Resolution

Resolve these at the start of every invocation, before mode selection.

```bash
CODEBASE_NAME=$(basename "$PWD")
CODEBASE_PATH="$PWD"
PLAN_NAME=""          # derived below — first stable noun from request, lowercased, spaces→hyphens
AGENT_ROOT="$CODEBASE_PATH/.agents"
PLAN_ROOT="$AGENT_ROOT/runs/$PLAN_NAME"
EXPERT_SLUG=""        # derived below — {FEATURE_SLUG}-{CODEBASE_NAME}
FEATURE_SLUG=""       # first noun phrase in request, lowercased, spaces→hyphens
DESIGN_DIR="$PLAN_ROOT/design"
SPEC_DIR="$PLAN_ROOT/spec"
DESIGN_DRAFT="$DESIGN_DIR/design-draft.md"
UNIVERSAL_SPEC="$SPEC_DIR/universal-spec.md"
```

Derivation rules:
- `FEATURE_SLUG`: take the first stable noun phrase in the request (e.g. "add estimate generation" → "estimate"; "refactor the auth layer" → "auth"). Lowercase, spaces and underscores → hyphens.
- `PLAN_NAME`: same as `FEATURE_SLUG` unless the user supplies an explicit name.
- `EXPERT_SLUG`: `{FEATURE_SLUG}-{CODEBASE_NAME}` (e.g. "estimate-Propel-ADW").

Create output directories:
```bash
mkdir -p "$DESIGN_DIR" "$SPEC_DIR"
```

Print resolved values before proceeding:
```
CODEBASE_NAME: {value}
CODEBASE_PATH: {value}
PLAN_ROOT:     {value}
EXPERT_SLUG:   {value}
```

---

## Mode Selection

Before starting, determine which mode applies.

**Mode A — Design from scratch**
Signals: new feature, new service, new domain concept, greenfield, "add X", "build Y".
No existing code to constrain the design. Work entirely from the request and principles.

**Mode B — Analysis-driven design**
Signals: "change X", "fix the Y layer", "refactor Z", the request references existing files or types.
Run architecture context acquisition first (see below), then design the changes against what exists.

State the mode explicitly before proceeding.

---

## Pre-Flight Classification

After selecting a mode, classify what pre-work the request needs. Present the classification and wait for user confirmation before reading reference files or starting design.

### Signal Checklist

**Trace** — request touches existing code that may have type drift, field mismatches, or duplicated logic:
- "fix", "change", "refactor", "update", "extend" an existing feature
- Describes a bug that sounds like silent failure: wrong data, missing fields, inconsistent results across contexts
- The affected area crosses multiple layers (HTTP → service → DB)
- Audit-db has open CRITICAL or MAJOR findings in the relevant area

**Research** — design depends on information not in the codebase:
- Mentions a third-party service, external API, or library not currently used
- Asks "what's the best way to" or "how should we" — options exist and need evaluation
- Involves a pattern (auth strategy, caching approach, queue design) where trade-offs matter
- References an external spec, RFC, or standard that should govern the design

**Reflection only** — principles and existing audit context are sufficient:
- Purely additive: new entity, new endpoint, new feature following an established pattern
- No external dependencies to evaluate
- The pattern already exists in the codebase — this is an extension, not a decision

### Classification Output

Print this block, then stop and wait for user input before proceeding:

```
Pre-flight classification

Request: {one-sentence summary}

Suggested pre-work:
  [✓/✗] Trace      — {area affected, dimension suspected: structural/behavioral/operational/compute}
  [✓/✗] Research   — {what external information is needed}
  [✓/✗] Reflection — {whether principles + audit-db alone are sufficient}

Rationale:
  {2-3 sentences explaining the classification — what signals drove it}

Proceed with this plan, or describe what to change:
```

### After User Confirms

Execute pre-work in the order confirmed:

- **Trace confirmed**: run `/trace types` or `/trace coverage` on the affected area. Use the trace output as additional context in Step 1 — domain nouns, existing type names, and drift findings constrain the design.
- **Research confirmed**: spawn a `researcher` agent with the specific question. Use findings to inform the interface and schema decisions in Steps 2–3.
- **Reflection only**: proceed directly to Mode B Context Acquisition (if Mode B) or Step 1 (if Mode A).
- **User amends**: adjust the plan as directed, execute what they specified, then proceed.

Do not start Step 1 until pre-work is complete and its output is in context.

---

## Expert Loading

This friend-facing distribution does not include expert skills or `expert-db.ts`. Proceed using live code, architecture outputs, and audit-db findings only.

---

## Mode B Only: Context Acquisition

If Mode B, read the codebase and audit DB before designing. Do not guess at what exists.

```bash
# List codebases and find the relevant one
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts codebases list

# Pull findings directly by codebase (no need to find audit ID first)
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts findings list --codebase <slug> --severity CRITICAL
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts findings list --codebase <slug> --severity MAJOR --limit 20

# Pull agreed terminology and recorded decisions for this codebase
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts glossary list --codebase <slug>
node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/audit-db.ts decisions list --codebase <slug>
```

If no audit exists or the last one is more than 7 days old, run `/architecture` on the affected paths first, then return here with its output.

Glossary terms feed Step 1 naming directly — these are already-agreed canonical names for this codebase. Decisions feed the constraints section of the spec.

Read the key files in the affected area:
- The schema files (what shapes exist at boundaries)
- The type files (what types are in play)
- The interface files (what contracts exist at layer boundaries)
- The entry point files for the affected feature

From this reading, build a working model:
- What types already exist that this change touches
- What interfaces already exist at the relevant boundaries
- What names are already canonical (confirmed by glossary + grep)
- What findings indicate problems this design must not reproduce

---

## Step 1 — Name the Domain Nouns

This is the most important step. Every other decision follows from the names.

**Constraint**: If a glossary term covers the concept, use it exactly. If your noun would collide with an existing type name but represents a different concept, add a trust-level prefix (`Raw`, `Validated`, `Persisted`) to disambiguate. Document the rationale in the noun table.

Apply the rules from `05-construction.md §Step 1`:

For each core concept in the request:
1. Write the precise, verbose noun — not `plan`, but `MigrationPlan`; not `user`, but `AuthenticatedUser` vs `DatabaseUserRow`
2. Test it: grep for this name in the existing codebase — does it appear? Would it clash? Would it be ambiguous?
3. Position it in the trust hierarchy: `raw`, `validated`, `parsed`, `persisted`, `transformed`
4. Define it in one sentence

**Output table:**

| Noun | Trust level | Definition | File it will live in |
|------|-------------|------------|---------------------|
| `EstimateRequest` | raw | Unvalidated input from the client POST body | `src/schemas/estimate.schema.ts` |
| `ValidatedEstimate` | validated | Estimate after schema parse, ready for service layer | `src/types/estimate.ts` |
| `PersistedEstimate` | persisted | Estimate row as stored in DB, from ORM select | `src/db/schema.ts` (inferred) |

Do not proceed to Step 2 until every concept in the request has a row in this table.

---

## Step 2 — Decide the Schema at Every Entry Point

For each noun that crosses a boundary (HTTP input, external API response, file read, DB jsonb column), write the exact schema structure.

Apply `05-construction.md §Step 2`.

**Constraint**: Zero hand-authored parallel types. Every type in this spec must be `z.infer<typeof XSchema>`. Any boundary without a schema in the existing codebase that your design touches must be retrofitted with one.

**Output:**

```
File: src/schemas/estimate.schema.ts

EstimateRequestSchema — z.object({
  jobId: z.string().uuid(),
  lineItems: z.array(LineItemSchema),
  requestedBy: z.string().min(1),
  validUntil: z.string().datetime().optional(),
})
  → type EstimateRequest = z.infer<typeof EstimateRequestSchema>

LineItemSchema — z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
})
  → type LineItem = z.infer<typeof LineItemSchema>
```

For every schema: write the field names, types, and constraints. No implementation yet — just the contract.

---

## Step 3 — Design the Interfaces at Layer Boundaries

For each layer boundary the feature crosses, write the interface contract.

Apply `05-construction.md §Step 4`.

**Constraint**: Every class in your design gets an `I`-prefixed interface at its layer boundary. Consumers import the interface, not the class. No exceptions.

**Boundaries to identify:**
- Route handler → service (what does the route hand in, what does it get back?)
- Service → repository (what DB operations are needed?)
- Service → external API client (what calls are made?)
- Any service → service dependency

**Output:**

```
File: src/services/estimates/IEstimateService.ts

interface IEstimateService {
  createEstimate(request: ValidatedEstimate): Promise<OperationResult<PersistedEstimate>>
  getEstimate(estimateId: string): Promise<OperationResult<PersistedEstimate>>
  updateEstimateStatus(estimateId: string, status: EstimateStatus): Promise<OperationResult<void>>
}
```

Every method: exact name, exact parameter types (using the nouns from Step 1), exact return type. No hand-waving.

---

## Step 4 — Decide the File Tree

With nouns, schemas, and interfaces decided, lay out every file that will exist.

Apply `./.agents/skills/architecture/reference/06-structure.md` for placement and naming rules.

**Constraint**: No file named `utils`, `helpers`, `common`, or `shared` without a domain qualifier. Wiring goes in the composition root. File size declarations must be honest — if a file will be >200 LOC, split it here, not during implementation.

```
src/
  schemas/
    estimate.schema.ts          [NEW] EstimateRequestSchema, LineItemSchema
  types/
    estimate.ts                 [NEW] EstimateStatus enum, derived types
  db/
    schema.ts                   [MODIFY] add estimates table definition
  services/
    estimates/
      IEstimateService.ts       [NEW] interface contract
      EstimateService.ts        [NEW] implementation
      EstimateRepository.ts     [NEW] DB operations
  app/
    api/
      estimates/
        route.ts                [NEW] POST /api/estimates, GET /api/estimates/[id]
  __tests__/
    services/
      EstimateService.test.ts   [NEW]
```

For each file:
- Mark it NEW or MODIFY
- State what it will contain (types/classes/functions by name)
- State its approximate size band (single-op unit 12–50 lines, domain manager 50–200, etc.)

No file is "TBD." No file is "contains helpers." Every file has a declared purpose and contents list before the builder touches it.

**Checkpoint A — Write design draft to disk**

After completing the file tree, write `$DESIGN_DRAFT` with this structure:

```markdown
# Design Draft — {PLAN_NAME}

## Section 1 — Domain Nouns
{paste Step 1 output table verbatim}

## Section 2 — Schemas
{paste Step 2 output verbatim}

## Section 3 — Interfaces
{paste Step 3 output verbatim}

## Section 4 — File Tree
{paste Step 4 output verbatim}
```

Steps 5–7 append to this file. Do not hold all four sections in context — write them to disk and continue.

---

## Step 5 — Define the Class and Function Signatures

For each non-trivial class or function, write the signature now.

Apply `05-construction.md §Step 5` for class naming rules.

**Constraint**: Signatures follow house-style patterns verbatim. Any utility already in the codebase is used from its canonical location — never re-implemented inline.

```
EstimateService implements IEstimateService
  createEstimate(request: ValidatedEstimate): Promise<OperationResult<PersistedEstimate>>
    — validates via EstimateRequestSchema (already done at route layer, service trusts it)
    — calls EstimateRepository.insert(request)
    — returns OperationResult.ok(persistedEstimate) or OperationResult.err(reason)

EstimateRepository
  insert(estimate: ValidatedEstimate): Promise<OperationResult<PersistedEstimate>>
  findById(estimateId: string): Promise<OperationResult<PersistedEstimate | null>>
  updateStatus(estimateId: string, status: EstimateStatus): Promise<OperationResult<void>>
```

Every class gets a verb-noun name that states single responsibility. Every method gets an exact signature. If a name is vague (`handle`, `process`, `manage`), rename it here — not in the code review.

---

## Step 6 — Verify Every Name Passes the Grep Test

Before writing the spec, run the grep test mentally on every domain noun from Step 1.

For each noun, trace: where is it born → how does it travel → where is it consumed?

If the noun disappears mid-journey (becomes `data`, `result`, `payload`), it will fail the grep test. Rename the intermediate forms now.

Check for:
- Nouns that are too generic — would grep return noise?
- Names that duplicate existing canonical names in the codebase
- Trust-level prefixes missing at boundaries (`raw`, `validated`, `persisted`)

Fix all renames before writing the spec. The spec is the commitment — names decided in the spec become the names in the code.

---

## Step 7 — Layer Into Phases

**Constraint**: Test pipeline phase is mandatory. No mocks — tests use real implementations (unit: real logic; integration: real DB/services; E2E: real backend API; UI: real frontend rendering). Every route and service your design touches must appear in the test pipeline with specific test file paths and named test cases.

Sequence the file tree into phases where each phase:
- Is independently executable (a builder can run it without the next phase existing)
- Leaves the system in a valid state (types compile, existing tests still pass)
- Delivers a testable increment when possible

**Phase ordering rule:** data contracts before logic, logic before consumers, consumers before tests that cross layers.

```
Phase 0 — Data Contracts [Foundation]
  Files: src/schemas/estimate.schema.ts, src/types/estimate.ts, src/db/schema.ts
  Testable outcome: types compile, schema parse works, DB migration runs

Phase 1 — Service Layer [Feature]
  Files: src/services/estimates/IEstimateService.ts, EstimateService.ts, EstimateRepository.ts
  Depends on: Phase 0
  Testable outcome: EstimateService.createEstimate() callable in isolation

Phase 2 — Route Layer [Feature]
  Files: src/app/api/estimates/route.ts
  Depends on: Phase 1
  Testable outcome: POST /api/estimates returns 201 with valid body

Phase 3 — Test Pipeline [Cross-cutting, always last]
  Agent A: test-creator (coverage assessment — reads audit-db + trace, detects infra)
  Agent B: tester (execution — runs gap-fill tests once assessment passes)
  Agent C: test-resolver (conditional — only if tester reports FAIL or PARTIAL)
  Depends on: Phase 1, Phase 2
```

### Test Pipeline Phase — Design Rules (mandatory)

Every spec must end with a Test Pipeline phase. This is not optional. Add it after all feature phases regardless of scope.

**Step A — Scan existing coverage before designing anything:**
```bash
find {codebase}/tests/ -type f \( -name "*.test.ts" -o -name "*.integration.test.ts" -o -name "*.contract.test.ts" \) | sort
find {codebase}/tests/ -name "*.scenario.md" | sort
```
Read existing test files. Do not specify test files for paths already covered.

**Step B — Select test modes by priority order:**

| Priority | Mode | Use when |
|----------|------|----------|
| 1 | `integration` | Any route, service, or DB change — always required |
| 2 | `contract` | Any interface boundary change — each side gets a half-test |
| 3 | `golden-master` | Complex transformations, formatters, serializers — lock output shape |
| 4 | `system` | Cross-feature behavior, auth flows, multi-step user journeys |
| 5 | `ui` | Any UI component or page change |
| 6 | `scenario` | User-facing flows requiring browser navigation |
| 7 | `ux` | New interaction patterns needing usability review |
| 8 | `unit` | Pure utility functions with no I/O — supplementary only |

Unit tests alone are insufficient for any route, service, or DB work. Default to integration. Add contract at every interface boundary. Add golden-master wherever output shape must not drift. Unit is added after the others, not instead of them.

**Step C — Declare infrastructure requirements:**

For each integration/system test:
- Docker required: yes/no (needed for testcontainer, real DB in CI)
- Env vars: list exactly (e.g. `DATABASE_URL`, `STRIPE_TEST_KEY`)
- External service dependency: yes/no

**Step D — Specify each test file exactly:**

For every test file, write:
- Exact path (e.g. `tests/estimates/estimate-service.integration.test.ts`)
- Mode label from the table above
- 3–5 named test cases (e.g. "createEstimate — returns 409 on duplicate jobId")
- Infra tier: `testcontainer` | `live` | `browser` | `pure`

No file is "write tests for EstimateService." Every file has a declared path, mode, and named cases.

**Phase section format for the spec:**

```
Phase N — Test Pipeline [Cross-cutting]

  N.A Test Assessment
  Layer: test-assess | Agent: test-creator
  Reads: audit-db findings for affected area + trace/{feature}
  Produces: coverage-assessment.md (PASS → N.B; BLOCK → tc-* gap tasks → N.B)

  N.B Test Execution
  Layer: test | Agent: tester          (when tests use @testcontainers or are pure)
  Layer: live | Agent: live-runner     (when tests need docker-compose up first)
  Modes: {list applicable modes}
  Infrastructure: Docker={yes/no}, compose_file={path or none}, env_vars=[{list}]

  N.C Test Resolution — spawned dynamically by execute if N.B reports FAIL or PARTIAL
  Agent: test-resolver | no spec section needed — orchestrator spawns it
```

### Audit Phase — Design Rules (conditional)

Include `layer:audit` tasks in a phase when the builder work touches error-handling code: catch blocks, fallback logic, async fire-and-forget, error response shapes, or UI that renders error states.

**Two audit agents — declare which applies:**

| Agent | Deploy when |
|-------|------------|
| `silent-failure-hunter` | Builder created or modified any catch block, `.catch()`, fallback value, or async call |
| `log-auditor` | Builder created or modified error response shapes OR there is UI that renders error states |

Audit tasks run **after reviewers pass, before testing**. They are read-only — ISSUES_FOUND does not block phase advancement. Findings feed the debt-triage notes queue; debt-triage decides NEW TASK or DEFER.

**Spec section format for audit tasks:**

```
Phase N.D — Audit [Cross-cutting, conditional]

  Error Handling Audit
  Layer: audit | Agent: silent-failure-hunter
  Reads: builder output for {phase N tasks}
  Produces: silent-failures.md (PASS or ISSUES_FOUND — non-blocking)

  Log & Response Shape Audit
  Layer: audit | Agent: log-auditor
  Reads: builder output for {phase N tasks}
  Produces: log-audit.md (PASS or ISSUES_FOUND — non-blocking)
```

Only include audit sections when the signal is present. Do not add them to every phase reflexively.

**Checkpoint B — Design draft complete**

Append Step 5, 6, and 7 output to `$DESIGN_DRAFT`:

```markdown
## Section 5 — Class and Function Signatures
{paste Step 5 output verbatim}

## Section 6 — Grep-Test Renames
{list any renames from Step 6 verbatim}

## Section 7 — Phase Structure
{paste Step 7 phase layout verbatim}
```

`$DESIGN_DRAFT` is now complete. Steps 8–9 read from this file — they do not need any architecture reference files in context.

---

## Step 8 — Write the Spec File

**Read `$DESIGN_DRAFT` in full.** This is your only input — the design decisions made in Steps 1–7 are recorded there. Do not re-read any architecture reference files.

Write the complete spec to `$UNIVERSAL_SPEC`.

Follow the format in `./.agents/skills/task-orchestration/references/universal-spec-format.md`.

Every section of the spec corresponds to one phase/file group. Every section must have:
- The exact file path
- The operation (create/modify)
- The exact names of types, functions, classes, and fields to create (from Steps 1–6)
- The acceptance criteria (grep-verifiable or test-verifiable)
- The layer label

The spec is the commitment document. A builder reading any section must be able to implement it without referring back to this conversation.

---

## Step 8.5 — Spec Review Gate

Do not hand off until the spec passes review.

### Spec Review

Spawn a `task-reviewer` sub-agent with this exact brief:

> **Your job**: Read `{UNIVERSAL_SPEC}` in full. Check every section against the checklist below. For each item that fails, name the exact spec section and the exact gap. Write `STATUS: PASS` if all pass. Write `STATUS: FAIL` followed by a numbered gap list if any fail.
>
> **Checklist**:
> 1. Every domain noun is named, defined, and placed in a specific file
> 2. Every entry point boundary has a schema with field names and types written out
> 3. Every type is declared as `z.infer<typeof XSchema>` — no hand-authored parallel types
> 4. Every layer boundary has an interface with exact method signatures
> 5. Every class has a verb-noun name stating single responsibility
> 6. Every file in the tree is NEW or MODIFY with declared contents
> 7. Every phase is independently executable — no phantom dependencies
> 8. No section contains "TBD", "as needed", "implement X logic", or "handle edge cases"
> 9. Every name passes the grep test — no generic names that would dissolve mid-journey
> 10. Test Pipeline phase is present as the final phase
> 11. Test modes are ranked by weight: integration and contract before unit
> 12. Every test file has an exact path, mode label, and 3–5 named test cases
> 13. Infrastructure requirements are declared (Docker y/n, env vars, external services)
> 14. Existing test coverage was not duplicated (no test files for already-covered paths)
> 15. Audit tasks (silent-failure-hunter / log-auditor) included when builder work touches error handling

**On STATUS: PASS**: proceed to Step 9.

**On STATUS: FAIL**: address each gap in `$UNIVERSAL_SPEC`. Proceed to Step 9. (One fix pass only.)

---

## Step 9 — Hand Off to Task-Orchestration

Once the spec exists:

```
/task-orchestration convert-to-tasks <plan-name>
```

Then when ready to execute:

```
/task-orchestration execute <plan-name>
```

Do not hand off until the spec has zero ambiguous sections. If a section says "implement the business logic" without specifying what the logic is, go back and decide it now. The cost of a vague section is a builder agent that guesses wrong and a reviewer that fails the task.

---

## Output Checklist

Before handing off, verify:

- [ ] Every domain noun is named, defined, and placed in a file
- [ ] Every entry point boundary has a schema with field names and types written out
- [ ] Every type is declared as `z.infer<typeof XSchema>` — no hand-authored parallel types
- [ ] Every layer boundary has an interface with exact method signatures
- [ ] Every class has a verb-noun name stating single responsibility
- [ ] Every file in the tree is NEW or MODIFY with declared contents
- [ ] Every phase is independently executable
- [ ] The spec has no sections containing "TBD", "as needed", or "implement X logic"
- [ ] Every name passes the grep test — no generic names that would dissolve mid-journey
- [ ] Test Pipeline phase is present as the final phase (assessment + execution + resolution)
- [ ] Test modes are ranked by weight: integration and contract before unit; unit only for pure utilities
- [ ] Every test file has an exact path, mode label, and 3–5 named test cases
- [ ] Infrastructure requirements are declared (Docker, env vars, external services)
- [ ] Existing test coverage was scanned before specifying new tests
- [ ] Audit tasks (silent-failure-hunter / log-auditor) are included in phases where builder work touches error handling, catch blocks, fallback logic, or error response shapes
