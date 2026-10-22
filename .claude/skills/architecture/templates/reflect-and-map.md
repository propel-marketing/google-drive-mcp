# Reflect and Map

You are the translation agent for an ADW audit of **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

You have one input: the structured element inventory produced by the census phase.
You have one job: apply ADW principles to produce the gap analysis and remediation plan.

Do not re-catalog. Do not re-read source files. The census is your ground truth.

Write all output to: `{{OUTPUT_PATH}}`

---

## ADW Reference Files

{{EMBEDDED_REFERENCE}}

Read each reference file listed above before beginning. They define what "correct" looks like.

---

## Inputs

**ADW Snapshot (your primary census):**
{{INVENTORY_YAML_PATH}}

Confirm this file ends with `Status: COMPLETE`. If missing or incomplete, return:
`Status: NEEDS_MORE_CONTEXT — [specific path] is missing or incomplete`

**Diagnose outputs (read these to inform priorities — they go deeper than the snapshot alone):**
{{DIAGNOSE_FILES}}

Each diagnose file is a JSONL file — confirm the last non-empty line of each parses as JSON with `"_summary":true` and `"status":"complete"`.
If any file is missing, unreadable, or has `"status":"needs_more_context"` in its summary record, return:
`Status: NEEDS_MORE_CONTEXT — [specific path] is missing or incomplete`

The diagnose files tell you:
- `diagnose-trace.jsonl` — which core structures dissolve in transit and where; use to elevate dissolution violations in the remediation plan
- `diagnose-scatter.jsonl` — which operations are scattered across 3+ places with no owner; use to add scatter fixes to the remediation plan
- `diagnose-dead-code.jsonl` — which error classes are never caught, which exports are dead, which stubs ship to production; use to add deletion/implementation items
- `diagnose-grep-test.jsonl` — which core concepts fail the grep test and why; use to prioritize naming fixes that most affect agent-readability

If the snapshot includes the extended observability sections (log_call_quality, trace_spans, metric_emissions, error_reports), include their gaps in Step 5. If it includes imports, constants, test_coverage, or config sections, include those gaps in Steps 8–9.

---

## What "Correct" Looks Like (ADW Principles Applied)

Before producing any output, internalize these rules from the reference files:

**Naming:**
- DB row type: `{Concept}Row`
- Insert input: `{Concept}Insert`
- Domain object (service layer): `{Concept}`
- API request body: `{Concept}Request` or `Create{Concept}Input`
- API response: `{Concept}Response`
- Schema: `{Concept}Schema`
- Enum: `{Concept}Status`, `{Concept}Kind`, `{Concept}Type`
- Interface: `I{Concept}` or `{Concept}Contract`

**Structure:**
- Every entry point must have a schema that calls `.parse()` or `.safeParse()` at the boundary
- Every TypeScript type derived from a schema must use `z.infer<typeof SchemaName>` — no separate declarations
- Every class with a public API must implement a named interface
- Every closed value set must be a named enum or Zod enum — no magic strings
- Every domain concept must have exactly one authoritative name per layer

**The Grep Test:**
For every concept in the inventory: can you grep one name and trace it from entry → service → database? If not, the naming is broken.

---

## Step 1 — Infer the Domain Model

From the element inventory, identify the core domain concepts — the nouns the feature reasons about.

For each concept, check coverage across building blocks using the inventory data:

```
## Domain Model

| Concept | Type | Schema | Enum | Interface | Class | DB Structure | API Structure | Folder |
|---------|------|--------|------|-----------|-------|-------------|--------------|--------|
| [Name]  | YES/NO file:line | YES/NO file:line | YES/NO file:line | YES/NO file:line | YES/NO file:line | YES/NO file:line | YES/NO file:line | YES/NO dir |
```

A concept with all YES is fully covered. A concept with gaps is where work is needed.

---

## Step 2 — Entry Point Coverage

From the inventory's `entry_points` section: list every unguarded or partial entry point.

```
## Entry Point Coverage

| Entry Point | guarded | Schema Needed | Risk |
|-------------|---------|---------------|------|
| file:line (POST) | NO | [ConceptSchema — new] | CRITICAL |
| file:line (GET)  | PARTIAL | [ConceptSchema — exists but not called here] | MAJOR |
```

Risk rule: unguarded → CRITICAL; partial → MAJOR; guarded → skip.

---

## Step 3 — Naming Map

For each element in the inventory that violates ADW naming conventions, produce the correct name.

```
## Naming Map

| Current Name | Location | Correct Name | Rule Violated |
|-------------|----------|-------------|---------------|
| data | src/services/ai/engine.ts:44 | conversationRow | Generic name — no concept |
| ConversationData | src/db/schema.ts:23 | ConversationRow | Missing layer suffix (DB row) |
| status (magic strings) | multiple | MessageStatus (z.enum) | Undeclared enum |
| handleMessage | src/services/ai/engine.ts:89 | processIncomingMessage | Generic verb — no concept |
```

For names that are already correct, confirm them:

```
Correctly named (no action):
  - ConversationSchema at src/services/ai/schema.ts:5 — correct pattern
  - MessageStatus at src/services/ai/types/enums.ts:3 — correct pattern
```

---

## Step 4 — Type Safety Map

From the inventory's `types` section (any: YES entries) and `schemas` section (type_derived: NO entries):

```
## Type Safety Gaps

| Location | Current | Should Be | Action |
|----------|---------|-----------|--------|
| file:line | `: any` | `: ConversationRow` | Replace `any` with derived type |
| file:line | `type Foo = { ... }` (separate from FooSchema) | `type Foo = z.infer<typeof FooSchema>` | Delete type, derive from schema |
```

---

## Step 5 — Observability Map

From the inventory's `observability` section:

```
## Observability Gaps

### Typed Result Returns
| Service / Function | Current | Should Be | Action |
|-------------------|---------|-----------|--------|
| file:line | THROWS | OperationResult<T> | WRAP in typed result; add TrackingMessage to both paths |
| file:line | NULL_ON_FAILURE | OperationResult<T> | REPLACE null return with { success: false, error, message } |

### TrackingMessage Coverage
| Endpoint | Has Message | Quality | Action |
|----------|-------------|---------|--------|
| POST file:line | NO | — | ADD message field to every Response.json() call |
| GET file:line | PARTIAL | developer-facing | REWRITE message for user — plain language, actionable |

### Swallowed Exceptions
| Location | Missing | Action |
|----------|---------|--------|
| file:line | stack, inputs | ADD console.error('[ClassName.method] failed', { inputs, error.message, stack: err.stack }) |

### Endpoint Drillability
| Endpoint | Score | Gap | Action |
|----------|-------|-----|--------|
| POST file:line | BROKEN | schema imported, output implicit, errors in 3 files | MOVE schema inline; add explicit response type; consolidate error messages |

### Local Variable Naming
| Location | Current | Should Be | Action |
|----------|---------|-----------|--------|
| file:line | const data | const conversationRow | RENAME |
| file:line | const result | const streamResult | RENAME |

### Log Call Quality (if inventory-log-calls was run)
| Location | Level | Quality | Issue | Action |
|----------|-------|---------|-------|--------|
| file:line | error | BARE | No error object, no inputs | ADD error object, function name, input IDs |

### Trace Spans (if inventory-trace-spans was run)
| Span Name | Location | Missing | Action |
|-----------|----------|---------|--------|
| create-user | file:line | no error recording | ADD span.setStatus(SpanStatusCode.ERROR) in catch |

### Metric Emissions (if inventory-metric-emissions was run)
| Metric Name | Location | Issue | Action |
|-------------|----------|-------|--------|
| user.signup | file:line | no tags | ADD tags: { env, status } |

### Error Reports (if inventory-error-reports was run)
| Location | Monitoring Lib | Missing | Action |
|----------|---------------|---------|--------|
| file:line | sentry | no user context | ADD Sentry.setUser({ id: userId }) before captureException |
```

If no observability gaps found: `Observability: no gaps found — typed results, TrackingMessage, boundary logging, and drillability all pass.`

---

## Step 8b — Imports and Constants Map (if inventories were run)

From the snapshot's `imports` and `constants` sections:

```
## Import Health

### Layer Violations
| File | Imports From | Direction | Action |
|------|-------------|-----------|--------|
| src/db/queries.ts:3 | ../services/user-service | db→service (inversion) | MOVE logic to service; DB layer must not import service layer |

### Scattered SDKs
| Package | Import Count | Files | Action |
|---------|-------------|-------|--------|
| stripe | 4 | [list] | CONSOLIDATE to single adapter: src/integrations/stripe/client.ts |

## Constants

### Magic Strings
| Value | Occurrences | Files | Action |
|-------|-------------|-------|--------|
| 'active' | 7 | [list] | CREATE UserStatus = z.enum(['active', 'inactive']); REPLACE all occurrences |

### Magic Numbers
| Value | Kind | File | Action |
|-------|------|------|--------|
| 5000 | TIMEOUT | src/services/stripe.ts:78 | CREATE const STRIPE_TIMEOUT_MS = 5000 |
```

If no import or constant violations found: omit this section.

---

## Step 8c — Config and Test Coverage Map (if inventories were run)

From the snapshot's `config` and `test_coverage` sections:

```
## Config Gaps

### Unvalidated Secret Reads
| Env Var | File | Issue | Action |
|---------|------|-------|--------|
| STRIPE_SECRET_KEY | src/integrations/stripe/client.ts:3 | direct process.env — no validation | MOVE to validated env module with z.string().min(1) |

## Test Coverage Gaps

### Untested Service Files
| File | Action |
|------|--------|
| src/services/notifications.ts | ADD unit tests covering happy path and error path |
```

If no config or test gaps found: omit this section.

---

## Step 6 — Enum Consolidation Map

From the inventory's `enums` section (form: MAGIC_STRING_CLUSTER entries and duplicated values):

```
## Enum Consolidation

| Current State | Locations | Authoritative Form | Action |
|--------------|-----------|-------------------|--------|
| Magic strings 'active', 'inactive' (7 occurrences) | [files] | `ConceptStatus = z.enum(['active', 'inactive'])` | CREATE enum; REPLACE magic strings |
| Separate TS enum + Zod enum with identical values | [files] | Zod enum only, TS type via z.infer | DELETE TS enum, derive type |
```

---

## Step 7 — Interface and Class Map

From the inventory's `classes` and `interfaces` sections:

```
## Class / Interface Gaps

| Element | Location | Gap | Action |
|---------|----------|-----|--------|
| ConversationEngine class | file:line | No interface — invisible to agents | CREATE IConversationEngine; class implements it |
| StaticHelpers class (STATIC_NAMESPACE) | file:line | No state — should be module | REFACTOR to exported functions |
| IStreamEmitter interface | file:line | No implementing class | Verify intent — if fulfilled by function, document it |
```

---

## Step 8 — Folder Structure Map

From the inventory's `structures` section and any misplaced files noted in the inventory:

```
## Folder Structure Changes

| Current Path | Correct Path | Reason |
|-------------|-------------|--------|
| src/types/conversation.ts | src/services/ai/types/conversation.ts | Colocate with owning service |
| src/app/api/chat/schema.ts | src/services/ai/schemas/chat-input.ts | Schemas belong in service layer |
```

If the current structure is appropriate: `Folder structure is appropriate. No moves needed.`

---

## Step 9 — Remediation Plan

Produce a prioritized, sequenced list. Rename before introduce. Within each phase, group by independence (parallel vs. sequential).

```
## Remediation Plan

### CRITICAL — Unguarded entry points (runtime safety)

1. CREATE schema for [entry point at file:line]
   File: src/...
   Add: export const ConceptInputSchema = z.object({ field: z.string() })
   Call: ConceptInputSchema.parse(await req.json()) at line N

### MAJOR — Type safety and missing contracts

2. DERIVE type from schema at file:line
   Current: export type Concept = { field: string }
   Change to: export type Concept = z.infer<typeof ConceptSchema>
   Delete: separate type declaration

3. CREATE interface IConceptService for ConceptService class at file:line
   Methods to declare: [methodName(params): ReturnType]

### MINOR — Naming and structural debt (rename first, in alphabetical order)

4. RENAME data → conversationRow at file:line
5. CREATE MessageStatus enum; replace N magic string occurrences
   Files to update: [list]
6. MOVE src/types/conversation.ts → src/services/ai/types/conversation.ts
```

---

## Step 10 — Summary

```
## Audit Summary

Feature: {{FEATURE_NAME}}
Codebase: {{CODEBASE_PATH}}

Domain concepts identified: N
  Fully covered (all building blocks present): N
  Partially covered (gaps): N — [list concept names]
  Missing entirely (no named representation): N — [list concept names]

Entry points: N total
  Guarded: N
  Unguarded (CRITICAL): N
  Partial: N

Building block gaps:
  Missing schemas at entry points: N
  `any` in trusted code: N
  Types declared separately from schemas: N
  Classes without interfaces: N
  Undeclared enums (magic strings): N
  Naming violations: N
  Misplaced files: N

Observability gaps:
  Services returning typed results: N of N (N throwing naked exceptions)
  Endpoints with TrackingMessage: N of N
  Swallowed catch blocks: N
  Endpoint drillability BROKEN/POOR: N
  Local variable naming violations: N

Remediation items: N total
  CRITICAL: N
  MAJOR: N
  MINOR: N

Top 3 highest-impact changes:
1. [change] — [why this matters most]
2. [change]
3. [change]
```

---

Append as final line:
`Status: COMPLETE`
