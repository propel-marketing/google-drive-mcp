# Diagnose — Schema Derivation

You are checking that types are derived from schemas, not authored independently, in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files:
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/types.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/types.jsonl`

---

## What This Diagnostic Proves

Schemas validate at runtime. Types check at compile time. When the schema and the type are written separately, they drift — a field added to the schema but not the type means the runtime accepts data the compiler doesn't know exists, and a field added to the type but not the schema means the compiler trusts data the runtime never validated.

The fix: derive the type from the schema. One source of truth. `type User = z.infer<typeof UserSchema>` cannot drift because the type is mechanically generated from the schema's shape.

This diagnostic checks for:
- Schemas without a derived type (the schema exists but no `z.infer` produces a type)
- Types without a corresponding schema (the type exists but no schema validates the shape it describes)
- Parallel definitions (both a schema and a hand-authored type with the same fields — the drift risk)

---

## Step 1 — Enumerate All Schemas

From the schemas inventory, list every schema with its file location.

If the inventory is incomplete, scan directly:

```bash
grep -rn "^export const [A-Z][A-Za-z]*Schema = z\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "^export const [A-Z][A-Za-z]* = z\.object\|^export const [A-Z][A-Za-z]* = z\.array" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each schema: name, file:line.

---

## Step 2 — Find Each Schema's Derived Type (If Any)

For each schema named `XSchema`, search for its `z.infer` derivation:

```bash
# In the same file as the schema
grep -rn "z.infer<typeof [A-Z]" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each schema, note:
- Has a `z.infer` type derived from it? (PASS — derivation present)
- Has no derived type? (Either no type is needed, or a type exists separately — check)

---

## Step 3 — Find Hand-Authored Types That Should Be Derived

From the types inventory, list every type alias and interface that describes a *data shape* (excluding utility types, function signatures, scalar aliases).

For each data-shape type, search for a schema with the same conceptual shape:

```bash
# Naming heuristic: type X usually has matching schema XSchema
grep -rn "^export const {TypeName}Schema\|^const {TypeName}Schema" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

If a same-named schema exists but the type is hand-authored (not `z.infer<typeof XSchema>`), this is a **DRIFT_RISK** — both definitions exist and can diverge.

If no matching schema exists, classify by whether the type *should* have one:

| Type role | Should have schema? |
|-----------|--------------------|
| Crosses an inbound boundary (request body, queue message, file content) | YES — DRIFT_RISK without one |
| DB row type | Often derived from ORM (Drizzle's `$inferSelect`); acceptable |
| Internal-only type (computed in code, never crosses boundary) | NO — schema unnecessary |
| Domain entity used at boundaries | YES |

For each type that should have a schema and doesn't: **MISSING_SCHEMA** violation.

---

## Step 4 — Find Parallel Definitions

Look for cases where both a schema and a hand-authored type with the same name exist:

```bash
# For each XSchema found, check if a type X also exists
for schema in {{SCHEMA_NAMES}}; do
  type_name="${schema%Schema}"
  grep -rn "^export type ${type_name}\b\|^export interface ${type_name}\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
done
```

For each match found, read both definitions:
- If the type is `z.infer<typeof XSchema>` — derivation present, no violation
- If the type is hand-authored with the same fields — **PARALLEL_DRIFT_RISK**

For each parallel definition: this is the worst case. Two source-of-truths for the same shape. Eventually they diverge.

---

## Step 5 — Check for Schema Imports Across Files

For each schema, check whether the consumer files import the *type* (correct) or the schema (also correct, for re-validation) or hand-author a parallel definition (incorrect):

```bash
grep -rn "import.*{{SchemaName}}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
grep -rn "import.*{{TypeName}}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

A consumer that constructs a "User-shaped" object inline, with its own type annotation, instead of importing the derived type, is a violation pattern even if the schema is correctly defined upstream.

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "type_safety"
- `diagnostic_type`: "schema_derivation"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"type_safety","diagnostic_type":"schema_derivation","severity":"MAJOR","file_path":"src/types/user.ts","line_number":12,"description":"PARALLEL_DRIFT_RISK: hand-authored UserCreate interface exists alongside UserCreateSchema — two sources of truth that can diverge","recommended_action":"Replace interface with: type UserCreate = z.infer<typeof UserCreateSchema>","finding_signature":"445566778899aa00","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"schema_derivation","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"parallel_drift_count":0,"missing_schema_count":0,"status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [parallel pair] — DRIFT_RISK — replace hand-authored type with z.infer<typeof Schema>
2. [type at boundary] — MISSING_SCHEMA — add schema and derive type
3. [consumer file] — inline hand-construction — import derived type
```

---

Append as final line:
`Status: COMPLETE`
