# Inventory — Schemas

You are cataloging every runtime schema and validator in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A schema is any runtime construct that validates the shape of data. Find ALL of these:

- Zod schemas (`z.object`, `z.string`, `z.array`, `z.union`, `z.discriminatedUnion`, etc.)
- Schemas that are defined but never called at runtime
- Schemas whose corresponding TypeScript type is declared separately (drift risk)
- Types derived from schemas via `z.infer<typeof X>` (correct pattern)
- Entry points (from inventory-entry-points) that have NO schema

---

## Step 1 — Find All Schema Declarations

```bash
grep -rn "= z\.object\|= z\.string\|= z\.array\|= z\.union\|= z\.discriminatedUnion\|= z\.enum\|= z\.record\|Schema = z\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "^export const [A-Z][A-Za-z]*Schema\b\|^const [A-Z][A-Za-z]*Schema\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each schema found: read its full declaration to understand what it validates.

---

## Step 2 — Find Schema Call Sites

```bash
grep -rn "\.parse(\|\.safeParse(\|\.parseAsync(\|\.safeParseAsync(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each `.parse()` or `.safeParse()` call: which schema is being called? At what file and line? Cross-reference with the entry points inventory — is this call at an entry point boundary?

---

## Step 3 — Find Schemas Defined But Never Called

For each schema found in Step 1, check whether `.parse()` or `.safeParse()` is called on it anywhere:

```bash
grep -rn "{SchemaName}\.parse\|{SchemaName}\.safeParse" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

A schema that is never called at runtime provides no protection — it exists only as a type annotation. Flag these.

---

## Step 4 — Check Type Derivation

```bash
grep -rn "z\.infer<typeof" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "^export type [A-Z][A-Za-z]* = z\.infer" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each schema, determine:
- Is the TypeScript type derived from the schema via `z.infer<typeof SchemaName>`? (correct — one source of truth)
- Or is the TypeScript type declared separately? (drift risk — two sources of truth)

```bash
grep -rn "^export type [A-Z][A-Za-z]* = {" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

These are independently declared types — check whether each one has a corresponding schema that it should be derived from.

---

## Step 5 — Write the Inventory

Write one JSONL line per schema to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "schemas"
- `kind`: "ZOD_SCHEMA" | "JOI_SCHEMA" | "YUP_SCHEMA" | "AJV_SCHEMA" | "CUSTOM_VALIDATOR"
- `name`: schema variable name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `validator_lib`: "zod" | "joi" | "yup" | "ajv" | "custom" | "unknown"
- `strict`: boolean | null
- `derived_type_name`: string | null (name of z.infer<typeof X> type if present)
- `direction`: "input" | "output" | "internal" | "unknown"

Example:
{"entry_type":"schemas","kind":"ZOD_SCHEMA","name":"CreateEstimateSchema","file_path":"src/estimates/schemas.ts","line_number":14,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","validator_lib":"zod","strict":true,"derived_type_name":"CreateEstimateInput","direction":"input"}

After all entries:
{"_summary":true,"entry_type":"schemas","total_count":N,"by_kind":{"ZOD_SCHEMA":0,"JOI_SCHEMA":0,"YUP_SCHEMA":0,"AJV_SCHEMA":0,"CUSTOM_VALIDATOR":0},"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
