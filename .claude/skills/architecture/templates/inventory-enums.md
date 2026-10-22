# Inventory — Enums

You are cataloging every enum-like construct in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

An enum is any mechanism that declares a closed set of valid values for a concept. Find ALL of these:

1. **TypeScript `enum` declarations** — `enum Status { Active = 'active', Inactive = 'inactive' }`
2. **Const objects used as enums** — `const STATUS = { Active: 'active', Inactive: 'inactive' } as const`
3. **String literal union types** — `type Status = 'active' | 'inactive'`
4. **Zod enum schemas** — `z.enum(['active', 'inactive'])` or `z.nativeEnum(Status)`
5. **Const arrays used as value sets** — `const VALID_STATES = ['pending', 'running', 'done'] as const`
6. **Magic strings in the wild** — repeated string literals that are de-facto enums but have no named declaration

This covers frontend + backend + database (check schema files, migration files, type files, service files, component files).

---

## Step 1 — Find TypeScript Enums

```bash
grep -rn "^export enum\|^enum " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

Read each enum declaration in full. Note the name, values, and file.

---

## Step 2 — Find Const Object Enums

```bash
grep -rn "} as const" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "as const$\|as const;" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each result, read the declaration to determine if it is a value set (enum-like) or a type annotation.

---

## Step 3 — Find Zod Enum Schemas

```bash
grep -rn "z\.enum\|z\.nativeEnum" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each: read the values. Does the corresponding TypeScript enum or union type exist? Is the Zod enum derived from the TS enum, or are the values duplicated?

---

## Step 4 — Find String Literal Union Types

```bash
grep -rn "type [A-Z][A-Za-z]* = '[a-z]" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each: how many values? Is there a Zod enum that corresponds? Are the values used directly as string literals elsewhere?

---

## Step 5 — Find Magic Strings (de-facto enums without declarations)

Look for repeated string literals in conditional logic — these are enums that were never declared:

```bash
grep -rn "=== '" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sort | uniq -c | sort -rn | head -30
```

```bash
grep -rn "status.*==\|state.*==\|type.*==\|role.*==" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each cluster of repeated values: is there a named enum or union type? Or are these magic strings scattered across the codebase?

---

## Step 6 — Check Usage Consistency

For each named enum found in Steps 1–4, check whether it is used consistently or whether equivalent magic strings also exist:

```bash
grep -rn "'{value}'" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

(Run for each known enum value — e.g., `'pending'`, `'running'`, `'done'` for a state enum.)

---

## Step 7 — Write the Inventory

Write one JSONL line per enum construct to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "enums"
- `kind`: "TS_ENUM" | "CONST_OBJECT" | "ZOD_ENUM" | "STRING_UNION" | "CONST_ARRAY" | "MAGIC_STRING_CLUSTER"
- `name`: enum name or brief description for unnamed clusters (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `values`: array of strings (the declared values)
- `has_zod_counterpart`: boolean
- `has_ts_counterpart`: boolean
- `values_duplicated`: boolean (true if values are copy-pasted rather than derived)
- `used_consistently`: "YES" | "NO" | "PARTIAL" (whether magic strings exist alongside)

Example:
{"entry_type":"enums","kind":"TS_ENUM","name":"UserStatus","file_path":"src/users/types.ts","line_number":3,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","values":["ACTIVE","INACTIVE","PENDING"],"has_zod_counterpart":true,"has_ts_counterpart":true,"values_duplicated":false,"used_consistently":"YES"}

After all entries:
{"_summary":true,"entry_type":"enums","total_count":N,"by_kind":{"TS_ENUM":0,"CONST_OBJECT":0,"ZOD_ENUM":0,"STRING_UNION":0,"CONST_ARRAY":0,"MAGIC_STRING_CLUSTER":0},"inconsistent_usage_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
