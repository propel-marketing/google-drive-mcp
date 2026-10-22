# Inventory — Magic Numbers

You are cataloging every numeric literal used in logic (not trivially 0 or 1) in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A magic number is a numeric literal with semantic meaning that belongs in a named constant. Unlike magic strings, not all numbers are violations — `0` and `1` used as loop bounds or empty-check conditions are fine. The question is whether a number encodes business logic.

```typescript
// Magic number (violation)
if (retryCount > 3) { ... }
setTimeout(fn, 5000);
const maxFileSize = 10 * 1024 * 1024;

// Named constant (correct)
if (retryCount > MAX_RETRIES) { ... }
setTimeout(fn, API_TIMEOUT_MS);
const maxFileSize = MAX_UPLOAD_SIZE_BYTES;
```

---

## Step 1 — Find Non-Trivial Numeric Literals

```bash
grep -rn "[^0-9][2-9][0-9]\{2,\}\|[^0-9][1-9][0-9]\{3,\}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "version\|0x\|line_number\|port" | head -40
```

```bash
grep -rn "setTimeout\|setInterval\|delay\|sleep" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "[0-9]\{3,\}" | head -20
```

For each numeric literal: what does this number mean? Is it a timeout, a retry count, a size limit, a port number, a rate limit?

---

## Step 2 — Find HTTP Status Codes as Literals

```bash
grep -rn "status(.*4[0-9][0-9]\|status.*5[0-9][0-9]\|\.status = [45][0-9][0-9]" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

HTTP status codes used as literals are a special case — they are widely understood but still benefit from named constants for readability.

---

## Step 3 — Find Existing Named Numeric Constants

```bash
grep -rn "^export const [A-Z_]*_MS\|^export const [A-Z_]*_BYTES\|^export const [A-Z_]*_LIMIT\|^export const [A-Z_]*_TIMEOUT\|^export const MAX_\|^export const MIN_" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

---

## Step 4 — Write the Inventory

Write one JSONL line per magic number site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "magic_numbers"
- `kind`: "TIMEOUT" | "RETRY_COUNT" | "SIZE_LIMIT" | "HTTP_STATUS" | "PORT" | "RATE_LIMIT" | "UNKNOWN"
- `name`: string representation of the number (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `numeric_value`: number
- `has_named_constant`: boolean
- `constant_ref`: string | null

Example:
{"entry_type":"magic_numbers","kind":"TIMEOUT","name":"5000","file_path":"src/services/stripe.ts","line_number":78,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"ai_judged","numeric_value":5000,"has_named_constant":false,"constant_ref":null}

After all entries:
{"_summary":true,"entry_type":"magic_numbers","total_count":N,"by_kind":{"TIMEOUT":0,"RETRY_COUNT":0,"SIZE_LIMIT":0,"HTTP_STATUS":0,"PORT":0,"RATE_LIMIT":0,"UNKNOWN":0},"with_named_constant":0,"without_named_constant":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
