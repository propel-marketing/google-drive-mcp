# Diagnose — Boundary Completeness

You are checking that every external entry point validates incoming data with a schema and that every outbound boundary produces a typed response in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files:
- `{{INV_DIR}}/entry-points.jsonl`
- `{{INV_DIR}}/schemas.jsonl`

Write all findings to: `{{OUTPUT_PATH}}` (extension `.jsonl`)

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/entry-points.jsonl`
- `{{INV_DIR}}/schemas.jsonl`

---

## What This Diagnostic Proves

Every place data enters the system is a trust boundary. Without a schema at that boundary, untrusted data flows directly into typed code, corrupting the type system's guarantees three layers deep before anything notices. The schema is the gatekeeper: untrusted input either passes and becomes a typed, trusted object, or fails immediately at the edge with a specific error.

Three things must hold:
- Every inbound boundary has a schema
- Every schema rejects with a specific, localized error message
- Types crossing the boundary are *derived* from the schema, not authored separately

---

## Step 1 — Enumerate Every Inbound Boundary

From the entry-points inventory, list every:
- HTTP route handler (request bodies, query params, headers used)
- CLI command (argv parsing)
- Queue / message-bus consumer (incoming message payloads)
- Webhook receiver (third-party payloads)
- File watcher / file uploader (file content)
- Scheduled job entry point (cron triggers — usually no payload, but check)

For each boundary, record: file path, line, transport, what data crosses, in what direction.

If the inventory files don't fully cover all boundary types, also scan:

```bash
grep -rn "export async function POST\|export async function PUT\|export async function PATCH\|export async function DELETE" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "z.object\|z.array\|z.union\|.parse(\|.safeParse(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

---

## Step 2 — Match Each Boundary to a Schema

For each inbound boundary, find the schema that validates it. Read the entry point file. Search for:

- `Schema.parse(req.body)` or `Schema.safeParse(req.body)`
- `validate(input)` calls
- Equivalent runtime validators in your stack (yup, joi, ajv, pydantic, zod)

Classify each boundary:

| Status | Meaning |
|--------|---------|
| **VALIDATED** | Boundary calls a schema's parse/validate function on the incoming data; rejects on failure |
| **TYPED_NO_SCHEMA** | Cast `as Type` directly without a runtime check (`req.body as User`) — type system is lying |
| **UNTYPED** | Data flows in without any schema or cast — `req.body` is `any` |
| **PARTIAL** | Some fields validated, others trusted (e.g., body validated but headers used directly) |

For each TYPED_NO_SCHEMA, UNTYPED, or PARTIAL: violation. Note exactly what data enters without validation.

---

## Step 3 — Check Schema Quality

For each VALIDATED boundary, read its schema. Apply these checks:

### Strictness
- Does the schema reject unknown fields? (`.strict()` in Zod, `additionalProperties: false` in JSON Schema)
- Or does it pass through extras silently?

Strict schemas surface drift. Permissive schemas hide it.

### Error specificity
- On rejection, does the error message identify the field and the violation?
- Or does it produce a generic "validation failed"?

```bash
grep -rn ".parse(\|.safeParse(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

For each parse call: is the error path explicit? Does it return a 400 with the issue, or does it crash to a generic 500?

### Type derivation
The type used downstream of the boundary should be derived from the schema (`z.infer<typeof Schema>`), not authored separately.

```bash
grep -rn "z.infer\|InferType\|TypeOf<" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each schema, find its corresponding type. If the type is hand-authored elsewhere (separate `interface` declaration with same fields): drift risk — the schema and type can diverge.

---

## Step 4 — Check Outbound Boundaries

For each outbound boundary (HTTP response, webhook payload, queue message produced, log line):

- Is the response shape declared as a typed return? Or is it constructed inline as an untyped object?
- For HTTP responses, is the response type co-located with the route handler, or hidden in a service?

```bash
grep -rn "NextResponse.json(\|res.json(\|response.json(\|return Response.json(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each response, check whether the data passed to `.json()` has a declared type. If anonymous shape construction, flag.

---

## Step 5 — Cross-Reference With Schema Inventory

From the schemas inventory, list every schema. Cross-reference with boundaries:

| Schema | Used at boundary | Status |
|--------|------------------|--------|
| UserCreateSchema | src/app/api/users/route.ts:34 | USED |
| UserUpdateSchema | (nowhere) | ORPHAN |
| LegacyOrderSchema | (nowhere) | ORPHAN |

Schemas defined but never used at a boundary are dead schemas — either the boundary was removed or the schema was never wired in. Flag.

Boundaries without a corresponding schema, conversely, are unguarded.

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "boundary_hygiene"
- `diagnostic_type`: "boundary_completeness"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"boundary_hygiene","diagnostic_type":"boundary_completeness","severity":"CRITICAL","file_path":"src/app/api/estimates/route.ts","line_number":22,"description":"POST handler accepts body without schema validation — raw input reaches service layer","recommended_action":"Add CreateEstimateSchema.parse(body) before service call","finding_signature":"c6d4e2f0a8b9c1d3","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"boundary_completeness","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [boundary] — UNTYPED — add schema and validate body before any downstream call
2. [boundary] — TYPED_NO_SCHEMA — replace cast with schema parse
3. [schema] — separate parallel type — derive type from schema
4. [boundary] — generic error path — add field-specific error response
```

---

Append as final line:
`Status: COMPLETE`
