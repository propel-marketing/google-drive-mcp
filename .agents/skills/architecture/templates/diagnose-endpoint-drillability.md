# Diagnose — Endpoint Drillability

You are auditing whether each endpoint in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` is a self-contained unit — readable from one file without jumping across the codebase.

Your input is the entry-points inventory.

Write all findings to: `{{OUTPUT_PATH}}` (extension `.jsonl`)

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read this file first. Confirm it ends with `Status: COMPLETE`.
If missing or incomplete: `Status: NEEDS_MORE_CONTEXT — entry-points inventory is missing or incomplete`

{{PRIOR_FILE_1}}    (entry-points inventory)

---

## What This Diagnostic Proves

An endpoint is drillable if a reader can answer four questions about it without leaving the file:

1. **What comes in?** — the schema or shape of incoming data
2. **What goes out?** — the response shape
3. **What can fail?** — the error cases and HTTP status codes
4. **What does the user see?** — the user-facing messages

If you have to open five files to answer those four questions, the endpoint has leaked its concerns across the codebase. That's a drillability failure regardless of whether the code is otherwise correct.

The diagnostic checks each endpoint and scores it on the four-question test.

---

## Step 1 — Enumerate Every Endpoint

From the entry-points inventory, list every:
- HTTP route handler
- CLI command entry point
- Queue consumer
- Webhook receiver
- File watcher / scheduled job entry

For each, record: file path, transport, method/event, line.

If the inventory is incomplete, scan directly:

```bash
grep -rn "export async function GET\|export async function POST\|export async function PUT\|export async function PATCH\|export async function DELETE\|export const GET\|export const POST" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

---

## Step 2 — Apply the Four-Question Test to Each Endpoint

For each endpoint file, read it fully. Answer each of the four questions *without opening any other file*:

### Q1: What comes in?
- PASS: a schema parse call is visible in this file (e.g., `BodySchema.parse(req.body)`)
- PASS: an imported schema is referenced inline (e.g., `BodySchema.parse(...)`) — note that the schema is one hop away
- FAIL: the input shape is implied, untyped, or only documented elsewhere

### Q2: What goes out?
- PASS: the response is constructed with an explicit shape declaration (typed return, schema-derived)
- PASS: the response shape is visible in the body of the function
- FAIL: the response is constructed by calling a service function whose return type is not visible in this file

### Q3: What can fail?
- PASS: the file shows explicit error returns (e.g., `return Response.json({error}, {status: 400})`)
- PASS: try/catch blocks visible with specific status codes
- FAIL: errors propagate to a global handler that lives elsewhere; this file shows no error pathway

### Q4: What does the user see?
- PASS: user-facing messages appear in the file (status codes mapped to texts, error messages defined inline)
- PASS: messages come from a registered translation file referenced in this file
- FAIL: user-facing messages are constructed in a service or middleware not referenced from this endpoint

---

## Step 3 — Score Each Endpoint

For each endpoint, count how many of the four questions PASS:

| Score | Verdict |
|-------|---------|
| 4 / 4 | EXCELLENT |
| 3 / 4 | GOOD |
| 2 / 4 | POOR |
| 0–1 / 4 | BROKEN |

For every POOR or BROKEN endpoint: specify exactly which question failed and which file holds the answer (so the reader knows where the concern leaked to).

---

## Step 4 — Identify Leakage Patterns

For each failed question across endpoints, group the failures by *where the answer lives*:

| Failed question | Common leak destination | Endpoints affected |
|----------------|------------------------|--------------------|
| Q1 (input) | imported types in `src/types/` | N endpoints |
| Q2 (output) | service-layer return types | N endpoints |
| Q3 (errors) | global error handler `src/middleware/error.ts` | N endpoints |
| Q4 (user messages) | i18n / translations file | N endpoints |

This pattern surfaces *where* drillability concerns are leaking systemically. Q3 leaks to a global handler? That's a single-file fix. Q2 leaks to services? That's a per-endpoint refactor.

---

## Step 5 — Spot-Check Three Endpoints In Detail

Pick three endpoints across different score bands (one EXCELLENT, one POOR, one BROKEN if available). Walk through each and write a narrative:

```
### Endpoint: POST /api/orders (BROKEN — 1/4)

File: src/app/api/orders/route.ts (47 lines)

Q1 (input): FAIL — function signature is `(req: Request)`. No schema parse visible. To know the expected body, reader must open `src/services/orders/types.ts` and `src/services/orders/validate-order.ts`.

Q2 (output): FAIL — handler returns `await processOrder(input)`. Return type of processOrder is not declared here. Reader must open `src/services/orders/processor.ts`.

Q3 (errors): PARTIAL — try/catch with generic `return new Response('Error', {status: 500})`. No specific error cases.

Q4 (user messages): FAIL — error message is "Error". User-facing copy lives in `src/messages/en.json` keyed by status code. Reader cannot tell from this file what the user actually sees.

Recommendation: 
- Move BodySchema definition or import inline; show the parse call.
- Annotate response type explicitly.
- Add specific error returns with status codes 400/404/422.
- Either inline the user-facing message or comment-link to its registry.
```

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "boundary_hygiene"
- `diagnostic_type`: "endpoint_drillability"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"boundary_hygiene","diagnostic_type":"endpoint_drillability","severity":"CRITICAL","file_path":"src/app/api/estimates/route.ts","line_number":22,"description":"POST handler accepts body without schema validation — raw input reaches service layer","recommended_action":"Add CreateEstimateSchema.parse(body) before service call","finding_signature":"c6d4e2f0a8b9c1d3","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"endpoint_drillability","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [endpoint] — BROKEN (1/4) — inline schema, declare response type, add specific error returns
2. [pattern] — Q3 leaks systemically to global handler — endpoints should declare their failures locally
3. [pattern] — Q4 leaks to i18n — reference the message key inline so the reader can navigate one hop
```

---

Append as final line:
`Status: COMPLETE`
