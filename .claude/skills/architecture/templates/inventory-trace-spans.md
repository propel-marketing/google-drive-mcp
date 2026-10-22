# Inventory — Trace Spans

You are cataloging every distributed tracing span in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Trace spans are instrumentation that records the timing and context of operations for distributed tracing (OpenTelemetry, Jaeger, Datadog APM, etc.). This inventory maps where the codebase creates spans and whether span coverage is consistent.

Find ALL of these:
- `tracer.startSpan(...)` / `tracer.startActiveSpan(...)` (OpenTelemetry)
- `span.setAttribute(...)` / `span.setStatus(...)` / `span.end()`
- `dd.tracer.startSpan(...)` (Datadog)
- Custom span wrappers (`withSpan(...)`, `instrument(...)`)

---

## Step 1 — Find Span Creation

```bash
grep -rn "startSpan\|startActiveSpan\|createSpan\|withSpan\|instrument(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

```bash
grep -rn "opentelemetry\|@opentelemetry\|dd-trace\|datadog" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

---

## Step 2 — Find Span Attribute Setting

```bash
grep -rn "setAttribute\|setAttributes\|addEvent\|setStatus\|recordException" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

For each span: does it set meaningful attributes (operation name, entity IDs, relevant metadata)? Or just a bare span name?

---

## Step 3 — Assess Coverage Gaps

From the service functions and route handlers found in other inventories, identify which are instrumented with spans and which are not.

```bash
grep -rn "export async function\|export function" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | head -20
```

---

## Step 4 — Write the Inventory

Write one JSONL line per span creation site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "trace_spans"
- `kind`: "OTEL_SPAN" | "DATADOG_SPAN" | "CUSTOM_WRAPPER" | "MANUAL"
- `name`: span name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `has_attributes`: boolean (sets meaningful attributes beyond name)
- `has_error_recording`: boolean (uses setStatus or recordException on error)
- `span_lib`: string (e.g., "@opentelemetry/api", "dd-trace")

Example:
{"entry_type":"trace_spans","kind":"OTEL_SPAN","name":"create-user","file_path":"src/services/user-service.ts","line_number":25,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","has_attributes":true,"has_error_recording":false,"span_lib":"@opentelemetry/api"}

After all entries:
{"_summary":true,"entry_type":"trace_spans","total_count":N,"by_kind":{"OTEL_SPAN":0,"DATADOG_SPAN":0,"CUSTOM_WRAPPER":0,"MANUAL":0},"with_error_recording":0,"without_error_recording":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
