# Inventory — Result Types

You are cataloging every function that returns a typed result shape (vs. throwing) in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A result type is a deliberate return shape that encodes both success and failure without relying on exceptions:

```typescript
{ success: true; data: T; message: string }
{ success: false; error: string; message: string }
```

Or equivalent patterns: `Result<T, E>`, `Either<L, R>`, `Option<T>`, `Promise<{ ok: true; value: T } | { ok: false; error: E }>`.

The question is: do service functions encode their failure modes in the return type, or do they throw and leave callers to guess what can fail?

---

## Step 1 — Find Typed Result Patterns

```bash
grep -rn "{ success:\|{ ok:\|OperationResult\|Result<\|Either<\|Option<" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "return { success: true\|return { success: false\|return { ok: true\|return { ok: false" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

---

## Step 2 — Find Throwing Functions in Service Layer

```bash
grep -rn "throw new\|throw err\|throw error" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each throw in service code: is this an expected failure (should be a typed result) or a programming error (appropriate to throw)?

---

## Step 3 — Find TrackingMessage / User-Facing Messages

```bash
grep -rn "message:" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "success\|error\|failure" | head -20
```

For each function returning a result: does both the success and failure path include a `message` field with a user-readable string?

---

## Step 4 — Write the Inventory

Write one JSONL line per service/handler function to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "result_types"
- `kind`: "TYPED_RESULT" | "THROWS" | "NULL_ON_FAILURE" | "MIXED" | "VOID"
- `name`: function name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `has_tracking_message`: boolean (both success and failure paths include user-readable message)
- `result_type_name`: string | null (e.g., "OperationResult", "Result<T,E>")

Example:
{"entry_type":"result_types","kind":"TYPED_RESULT","name":"createUser","file_path":"src/services/user-service.ts","line_number":23,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"ai_judged","has_tracking_message":true,"result_type_name":"OperationResult"}

After all entries:
{"_summary":true,"entry_type":"result_types","total_count":N,"by_kind":{"TYPED_RESULT":0,"THROWS":0,"NULL_ON_FAILURE":0,"MIXED":0,"VOID":0},"with_tracking_message":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
