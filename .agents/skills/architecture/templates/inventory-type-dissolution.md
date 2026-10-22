# Inventory — Type Dissolution

You are cataloging every site where the type system loses its guarantee in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Type dissolution is when a typed value loses its identity in the compiler's view. Every dissolution is a downstream invitation for hallucinations — agents invent properties that may or may not exist.

| Mechanism | What to look for |
|-----------|-----------------|
| `: any` annotation | Variables, parameters, or return types explicitly typed `any` |
| `: unknown` without narrowing | Unnarrowed `unknown` values flowing through trusted code |
| `: object` / `: {}` | The broadest structural types — accept any object shape |
| `as any` casts | Explicit erasure of type information |
| Trust-me casts (`as T` without parse) | Covered in inventory-type-operations — cross-reference |

---

## Step 1 — Find `any` Usages

```bash
grep -rn ": any\b\|<any>\|as any\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "// eslint-disable"
```

For each occurrence, read 5 lines of context. Classify:
- **BOUNDARY** — at an external boundary before `parse()` — acceptable (mark as INFO)
- **TRUSTED_CODE** — in service layer, DB layer, or utility code after parse — violation (CRITICAL)

---

## Step 2 — Find `unknown` and `object` Usages

```bash
grep -rn ": unknown\b\|<unknown>" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn ": object\b\|: Object\b\|: {}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

`unknown` is honest — flag only if it propagates without being narrowed. `object` and `{}` are almost always violations.

---

## Step 3 — Find `JSON.parse` and Untyped DB Reads

```bash
grep -rn "JSON\.parse\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "\$inferSelect\|\$inferInsert\|\.json()" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each `JSON.parse`: what type does the result carry downstream? Does it flow into typed code immediately via a schema parse, or does it propagate as `any`?

---

## Step 4 — Write the Inventory

Write one JSONL line per dissolution site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "type_dissolution"
- `kind`: "ANY_ANNOTATION" | "UNKNOWN_UNNARROWED" | "OBJECT_TYPE" | "ANY_CAST" | "JSON_PARSE_UNTYPED" | "DB_RESULT_UNTYPED"
- `name`: variable name or brief description (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `at_boundary`: boolean (true if acceptable boundary usage, false if in trusted code)
- `severity_class`: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

Example:
{"entry_type":"type_dissolution","kind":"ANY_ANNOTATION","name":"apiResponse","file_path":"src/services/billing.ts","line_number":67,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","at_boundary":false,"severity_class":"CRITICAL"}

After all entries:
{"_summary":true,"entry_type":"type_dissolution","total_count":N,"by_kind":{"ANY_ANNOTATION":0,"UNKNOWN_UNNARROWED":0,"OBJECT_TYPE":0,"ANY_CAST":0,"JSON_PARSE_UNTYPED":0,"DB_RESULT_UNTYPED":0},"in_trusted_code":0,"at_boundary":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
