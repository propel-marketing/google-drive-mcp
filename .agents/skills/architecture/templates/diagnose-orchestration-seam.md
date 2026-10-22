# Diagnose — Orchestration Seam

You are auditing whether background job dispatch, phase chaining, and async orchestration in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` maintains typed, schema-validated payloads across every process boundary — and whether the full chain topology is grep-constructible from code.

This diagnostic is discovery-driven via grep. No inventory file input required.

Write all findings to: `{{OUTPUT_PATH}}` (extension `.jsonl`)

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What This Diagnostic Proves

Every dispatch site is a boundary. When your code publishes a payload to a queue, chains to a next phase, or enqueues a background job, that payload crosses a process boundary and re-enters the system as untrusted input at the receiver. The same rule that applies to HTTP request bodies applies here: the payload must be schema-validated before dispatch (so the sender knows it's well-formed) and validated again on receipt (so the receiver cannot be corrupted by a malformed publish).

Three things must hold:
- Every dispatch site validates the payload against a schema before transport
- Every receiver validates the incoming payload before execution
- The full chain topology — which phase dispatches to which — is reconstructable by reading the code, not from memory

A chain that cannot be grepped end-to-end is undocumented architecture. A dispatch site without a schema is an unguarded boundary identical to an HTTP handler that accepts raw `req.body` without parsing.

---

## Phase 0 — Discovery (probe, do not assume)

Do not assume any specific library, pattern, or registry structure. Run each probe, record what was found, and carry the results into Phase 1.

### Probe A — Central registry or type enum

A registry or enum that lists all valid job/workflow/phase types is the richest starting point: it gives you the complete set of things that should exist, which you can then cross-reference against what actually dispatches and receives.

```bash
find {{CODEBASE_PATH}}/src -type f -name "registry.ts" -o -name "registry.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "WorkflowType\|JobType\|PhaseType\|TaskType\|QueueType\|EventType" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
grep -rn "Record<.*Type.*,\|satisfies Record" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -10
```

**Result A:** `REGISTRY_FOUND` (path and enum/type name) | `ENUM_ONLY` (type found, no registry) | `NOT_FOUND`

---

### Probe B — Orchestration library

Identify what transport mechanism the codebase uses. The library determines where to look for dispatch sites.

```bash
grep -rn "@upstash/qstash\|bullmq\|@temporalio\|bee-queue\|pg-boss\|graphile-worker\|inngest\|trigger.dev\|cloudtasks\|sqs" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | head -10
```

```bash
grep -rn "publishJSON\|sendMessage\|addJob\|enqueue\|scheduleWorkflow\|triggerWorkflow\|sendEvent" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

**Result B:** `LIBRARY:name` (e.g., `LIBRARY:qstash`) | `GENERIC_FETCH` | `IN_PROCESS_ONLY` | `NOT_FOUND`

---

### Probe C — Internal handler routes

Phase receivers are often mounted at internal paths not exposed externally. Find them.

```bash
find {{CODEBASE_PATH}}/src -type d -name "internal" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "maxDuration\|export const runtime\|PHASE\|phase.*route\|/internal/" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

**Result C:** `INTERNAL_ROUTES_FOUND` (list) | `NOT_FOUND`

---

### Probe D — In-process async patterns

If no queue library is found, look for in-process orchestration: event emitters, setImmediate chains, setTimeout-based scheduling, or direct async calls that chain phases.

```bash
grep -rn "setImmediate\|setTimeout\|EventEmitter\|\.emit(\|\.on(\|new Worker\|process\.nextTick" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
grep -rn "operationsEmitter\|jobEmitter\|eventBus\|pubsub" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -10
```

**Result D:** `EMITTER_FOUND` (name and file) | `SETTIMEOUT_CHAINS` | `NOT_FOUND`

---

### Probe E — Schema files for job payloads

Job/phase payload schemas are often co-located or centralized. Find them before looking at dispatch sites.

```bash
grep -rn "JobSchema\|PhaseSchema\|PayloadSchema\|WorkflowSchema\|QueueSchema" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
find {{CODEBASE_PATH}}/src -name "*.schema.ts" -o -name "schemas.ts" | grep -v node_modules | grep -v ".next" | grep -i "job\|phase\|queue\|workflow\|task"
```

**Result E:** `SCHEMAS_FOUND` (list of schema names and files) | `NOT_FOUND`

---

## Phase 1 — Route

Read your Discovery results. Select the detection path.

| Discovery result | Detection path |
|---|---|
| Result A = `REGISTRY_FOUND` | **Path 1 — Registry-anchored** (most complete) |
| Result A = `ENUM_ONLY` + Result B = `LIBRARY:*` | **Path 2 — Enum + dispatch search** |
| Result A = `NOT_FOUND` + Result B = `LIBRARY:*` | **Path 3 — Dispatch-site-first** |
| Result A = `NOT_FOUND` + Result B = `NOT_FOUND` + Result C = `INTERNAL_ROUTES_FOUND` | **Path 4 — Handler-first** |
| Result D = `EMITTER_FOUND` or `SETTIMEOUT_CHAINS` | **Path 5 — In-process chain** |
| All probes `NOT_FOUND` | **Path 6 — No orchestration detected** |

Record which path was selected and why.

---

## Phase 2 — Detect

### Path 1 — Registry-anchored

A central registry maps every type to its handler. This is the richest structure: cross-reference registered types against dispatched types and handler implementations.

**Step 1.1** — Read the registry file completely. Extract every registered type name.

**Step 1.2** — For each registered type, find its dispatch site(s):
```bash
grep -rn "{TypeName}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "registry\|import\|from "
```

Types registered but never dispatched to: **ORPHAN** (dead registered type, or undispatched handler).
Types dispatched to but not registered: **GHOST** (dispatch escapes the registry — runtime error).

**Step 1.3** — For each dispatch site, read the surrounding code (10 lines before the dispatch call). Is there a `.parse()` or `.safeParse()` call on the payload before transport?

- Schema found and called: **GUARDED**
- Schema exists but not called at this site: **UNENFORCED**
- No schema: **UNGUARDED** (CRITICAL)

**Step 1.4** — Construct the chain topology from dispatch sites. For each type, what does it dispatch to next? Build the directed graph in text:
```
Phase A → dispatches → Phase B (payload: PayloadASchema)
Phase B → dispatches → Phase C (payload: PayloadBSchema)
Phase C → terminal (no further dispatch)
```

Identify: cycles (CRITICAL), dead ends that aren't terminal (MAJOR), phases with no clear next step and no terminal marker (MAJOR).

**Step 1.5** — Check receiver-side validation using Result E (payload schemas). For each internal handler route, read it. Is there a schema parse call at the top before any business logic runs?

---

### Path 2 — Enum + dispatch search

No registry, but a type enum exists. Enumerate all types from the enum, then find dispatch and handler sites.

**Step 2.1** — Read the enum or union type completely. Record every value.

**Step 2.2** — For each value, search for both dispatch and handler:
```bash
grep -rn "'{value}'\|{VALUE}\|type: '{value}'" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Classify each hit: is it a dispatch site (sending this type) or a handler (receiving this type)?

**Step 2.3** — Apply the same schema checks and topology reconstruction as Path 1, steps 1.3–1.5.

**Step 2.4** — Note: without a registry, there is no compile-time enforcement that every type has a handler. Flag this gap as MAJOR if unaddressed.

---

### Path 3 — Dispatch-site-first

No registry, no central enum. Start from the transport mechanism's dispatch calls.

**Step 3.1** — Find all dispatch calls using the library identified in Result B:

For QStash: `grep -rn "publishJSON\|\.publish(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"`

For BullMQ: `grep -rn "\.add(\|\.addBulk(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"`

For generic: `grep -rn "enqueue\|schedule\|dispatch\|trigger" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30`

**Step 3.2** — For each dispatch call, read the full function that contains it. Extract:
- The target (URL, queue name, job type)
- The payload shape
- Whether a schema validates the payload before the call

**Step 3.3** — From each target, find the receiver:
```bash
grep -rn "{target_url_or_job_name}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Step 3.4** — Read the receiver. Does it validate the payload at entry? If not: CRITICAL.

**Step 3.5** — From each receiver, repeat: what does it dispatch next? Walk the chain until terminal or until a cycle is detected.

**Step 3.6** — Flag as MAJOR: no central registry or enum exists, meaning the full chain topology cannot be verified at compile time. The chain is reconstructable only by grepping — it is implicit architecture.

---

### Path 4 — Handler-first

No library, no registry, no enum. Internal routes exist. Start from handlers and work backward to callers.

**Step 4.1** — List all internal handler routes from Result C.

**Step 4.2** — For each handler, grep for its URL or route identifier across the codebase:
```bash
grep -rn "{handler_path}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

This finds callers (dispatch sites).

**Step 4.3** — For each caller, read the surrounding code. Is there a schema before the call? Is the call typed?

**Step 4.4** — Reconstruct chain topology backward from handlers to their callers.

**Step 4.5** — Any handler with no callers found: orphan (dead code or entry point — distinguish which). Any caller whose target URL resolves to no handler: broken dispatch (CRITICAL).

---

### Path 5 — In-process chain

Orchestration is via event emitter, setImmediate, or direct async calls — no external queue.

**Step 5.1** — Find the emitter or event bus (from Result D). Read its definition. What events does it declare?

**Step 5.2** — For each event, find all `.emit()` calls and all `.on()` handlers:
```bash
grep -rn "\.emit('{event}'\|\.on('{event}'" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Step 5.3** — Check whether event payload types are declared and consistent between emitter and handler. Untyped event payloads: MAJOR.

**Step 5.4** — setImmediate/setTimeout chains: read each call. What function does it call? Does that function eventually call another setImmediate? Walk the chain.

**Step 5.5** — Note: in-process orchestration does not survive process restarts, serverless cold starts, or scale-out. If the codebase is deployed serverlessly (Vercel, Lambda), flag all in-process chains as MAJOR — they are invisible to the runtime's reliability guarantees.

---

### Path 6 — No orchestration detected

All probes returned NOT_FOUND.

**Step 6.1** — Verify the negative: read `package.json` for any job, queue, or workflow dependencies not caught by the grep patterns.

**Step 6.2** — If genuinely absent: write one INFO finding: "No background orchestration detected — diagnostic not applicable." Status: COMPLETE.

**Step 6.3** — If dependencies exist but patterns were not found: the orchestration mechanism is ungreppable — the concepts are not named consistently in the code. Write as MAJOR: "Orchestration mechanism present (package: {name}) but dispatch sites not locatable by search — concepts lack canonical names."

---

## Phase 3 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `category`: "orchestration_seam"
- `diagnostic_type`: "orchestration_seam"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Severity guide:
- **CRITICAL**: unguarded dispatch (payload crosses boundary without schema), broken dispatch (target has no handler), cycle in chain
- **MAJOR**: receiver does not validate incoming payload, orphaned phase, chain topology not grep-constructible, in-process chain on serverless runtime
- **MINOR**: schema exists but is defined route-local rather than in a central schemas file, chain topology requires more than 2 file hops to reconstruct
- **INFO**: chain topology summary, path taken during detection

Summary record (last line before Status):
```json
{"_summary":true,"diagnostic_type":"orchestration_seam","detection_path":"Path N","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"dispatch_sites_found":N,"guarded":N,"unguarded":N,"chain_phases":N,"orphaned_phases":N,"status":"complete"}
```

---

Append as final line:
`Status: COMPLETE`
