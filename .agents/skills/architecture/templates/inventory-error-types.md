# Inventory — Error Types

You are cataloging every error class and error type declaration in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Error types are the declared vocabulary of failure. A well-typed error system lets callers handle specific failures without reading implementation details.

Find ALL of these:
1. **Error classes** — `class NotFoundError extends Error { ... }`
2. **Error type aliases** — `type AppError = NotFoundError | ValidationError | UnauthorizedError`
3. **Error enums/codes** — `enum ErrorCode { NOT_FOUND = 'NOT_FOUND', ... }`
4. **Error interfaces** — `interface ApiError { code: string; message: string; }`

---

## Step 1 — Find Error Classes

```bash
grep -rn "extends Error\|extends.*Error\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each error class: does it add a `code` field? Does it carry structured data? Is it ever caught specifically (not just as generic `Error`)?

---

## Step 2 — Find Error Type Aliases and Enums

```bash
grep -rn "type.*Error\b\|ErrorCode\|ErrorType\|ErrorKind" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "export type\|export enum\|export const" | head -20
```

---

## Step 3 — Check Throw/Catch Coverage

For each error class, find throw sites and specific catch sites:

```bash
grep -rn "throw new [A-Z][A-Za-z]*Error" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "catch.*[A-Z][A-Za-z]*Error\|instanceof [A-Z][A-Za-z]*Error" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

Classify each error class:
- **THROW_ONLY** — thrown at N sites, never caught specifically
- **COVERED** — thrown and caught specifically
- **DEAD** — never thrown

---

## Step 4 — Write the Inventory

Write one JSONL line per error type to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "error_types"
- `kind`: "ERROR_CLASS" | "ERROR_TYPE_ALIAS" | "ERROR_ENUM" | "ERROR_INTERFACE"
- `name`: error type name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `extends_class`: string | null (parent class for ERROR_CLASS)
- `has_code_field`: boolean
- `throw_site_count`: integer
- `specific_catch_count`: integer
- `coverage_status`: "COVERED" | "THROW_ONLY" | "DEAD"

Example:
{"entry_type":"error_types","kind":"ERROR_CLASS","name":"NotFoundError","file_path":"src/errors.ts","line_number":12,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","extends_class":"Error","has_code_field":true,"throw_site_count":4,"specific_catch_count":2,"coverage_status":"COVERED"}

After all entries:
{"_summary":true,"entry_type":"error_types","total_count":N,"by_kind":{"ERROR_CLASS":0,"ERROR_TYPE_ALIAS":0,"ERROR_ENUM":0,"ERROR_INTERFACE":0},"throw_only_count":0,"dead_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
