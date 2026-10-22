# Inventory — Types

You are cataloging every type alias and type-level mechanism in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

Types are the compiler-level shape descriptions of data. A *structure* is a named domain concept (`DatabaseSchemaResponse`); the *type* is what's inside it (`{ tables: Table[] }`).

| Find here | Find elsewhere |
|-----------|---------------|
| `type X = ...` declarations | `interface X { ... }` → inventory-interfaces |
| Utility-type applications (`Pick`, `Omit`, `Partial`, etc.) | Named domain data shapes → inventory-structures |
| Schema-derived types (`type X = z.infer<typeof Y>`) | Runtime validators → inventory-schemas |
| Scalar aliases (`type UserId = string`) | Closed value sets → inventory-enums |
| Function signature types | Implementing classes → inventory-classes |
| Mapped and conditional types | |
| Type guards (`x is T` predicates) | |
| Type assertions (`as T` casts) | |
| `any` / `unknown` / `object` usages — dissolution markers | |
| Re-exported types (drift risk) | |

If a declaration is a named domain entity (e.g., `User`, `Order`, `Estimate`), record it in inventory-structures instead.

---

## Phase 1 — Discover Type Files

Run this grep to get the list of files containing at least one type alias declaration. Returns file paths only — do not read files yet.

```bash
grep -rln "^export type [A-Z][A-Za-z]* =\|^type [A-Z][A-Za-z]* =" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" \
  | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sort
```

Also build these lookup sets now — stored in memory, not re-run per file:

**Generic types** (mapped/conditional — file:line pairs):
```bash
grep -rn "^export type [A-Z][A-Za-z]*<\|^type [A-Z][A-Za-z]*<" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Schema-derived types** (file:line pairs):
```bash
grep -rn "z\.infer<typeof\|z\.output<typeof" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

**Type guards** (file:line pairs):
```bash
grep -rn ": [a-zA-Z]* is [A-Z][A-Za-z]*\|function is[A-Z]" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Trust-me casts** (file:line pairs — `as T` on non-validated sources):
```bash
grep -rn " as [A-Z][A-Za-z]*\b\| as unknown\| as any\b" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "// eslint-disable"
```

**Dissolution markers** (file:line pairs):
```bash
grep -rn ": any\b\|<any>\|: unknown\b\|: object\b\|: {}" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Duplicate type names**:
```bash
grep -rn "^export type [A-Z][A-Za-z]*\b" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sed 's/.*export type //' | awk -F'[ =<]' '{print $1}' | sort | uniq -d
```

Store all results in memory. Do not re-run them per file.

Record the total file count. This is your lap count basis.

---

## Phase 2 — Lap Swimmer: Process Files in Batches

Process the file list in batches of **5 files per lap**. For each lap:

**Read each file completely.** Do not use grep -A snippets. Read the full file. This gives you complete import context, multi-line type bodies (mapped, conditional, intersection chains), and accurate classification regardless of declaration length.

For each file, extract every type alias declaration:

1. **Identify all type declarations** — find every `type X =` or `export type X =` keyword. For multi-line types, read to the final `;` at column 0 or the line where the expression closes.

2. **Determine kind**:
   - Body matches `z.infer<typeof …>` → SCHEMA_DERIVED
   - Body is `Pick<…> | Omit<…> | Partial<…> | Required<…> | Record<…>` → UTILITY_APPLICATION
   - Body is a single primitive alias (`string`, `number`, `boolean`) → SCALAR_ALIAS
   - Body is `'a' | 'b' | 'c'` (string literal union) → UNION (flag `is_closed_set_candidate: true`)
   - Body uses `&` → INTERSECTION
   - Body is a function type `(…) => …` → FUNCTION_SIGNATURE
   - Body uses `[K in keyof …]` or `{[K in …]: …}` → MAPPED
   - Body uses `T extends … ? … : …` → CONDITIONAL
   - From Phase 1 type-guard lookup → TYPE_GUARD
   - From Phase 1 trust-me cast or dissolution lookup → ASSERTION or DISSOLUTION
   - Everything else → TYPE_ALIAS

3. **Flag domain entity candidates** — names that represent business entities (`User`, `Order`, `Message`, `Invoice`, etc.) with object body shapes → set `is_domain_entity_candidate: true`

4. **Determine layer from imports** — read the import block at top of file. React/Next.js/UI libs → frontend. DB/ORM/infra libs → infrastructure. Both → shared. Neither → backend. Path alone is a fallback.

5. **Write JSONL entries immediately** — after processing each file, append entries to `{{OUTPUT_PATH}}` in append mode. Do not batch writes across laps.

**After each lap, write a checkpoint to stdout:**
```
Types lap {N}/{TOTAL_LAPS} complete — processed files {START}–{END} of {TOTAL_FILES}, wrote {N_ENTRIES} entries
```

---

## JSONL Schema

One line per type declaration. Every line must be valid JSON.

Required fields:
- `entry_type`: "types"
- `kind`: "TYPE_ALIAS" | "SCHEMA_DERIVED" | "UTILITY_APPLICATION" | "SCALAR_ALIAS" | "UNION" | "INTERSECTION" | "FUNCTION_SIGNATURE" | "MAPPED" | "CONDITIONAL" | "TYPE_GUARD" | "ASSERTION" | "DISSOLUTION"
- `name`: string — type name exactly as declared, or description for assertions
- `file_path`: path relative to codebase root
- `line_number`: integer — line of the `type` keyword
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "ai_judged"
- `is_schema_derived`: boolean
- `schema_source`: string | null — source schema name if schema-derived
- `is_domain_entity_candidate`: boolean
- `is_closed_set_candidate`: boolean
- `is_trust_me_cast`: boolean | null — for ASSERTION/DISSOLUTION: true if trust-me cast, false if boundary cast, null for all other kinds
- `has_duplicate_name`: boolean — from Phase 1 duplicate lookup

Example:
```
{"entry_type":"types","kind":"SCALAR_ALIAS","name":"UserId","file_path":"src/users/types.ts","line_number":5,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","is_schema_derived":false,"schema_source":null,"is_domain_entity_candidate":false,"is_closed_set_candidate":false,"is_trust_me_cast":null,"has_duplicate_name":false}
```

---

## Phase 3 — Summary

After all laps complete, append the summary line:

```
{"_summary":true,"entry_type":"types","total_count":N,"by_kind":{"TYPE_ALIAS":0,"SCHEMA_DERIVED":0,"UTILITY_APPLICATION":0,"SCALAR_ALIAS":0,"UNION":0,"INTERSECTION":0,"FUNCTION_SIGNATURE":0,"MAPPED":0,"CONDITIONAL":0,"TYPE_GUARD":0,"ASSERTION":0,"DISSOLUTION":0},"trust_me_casts":0,"domain_entity_candidates":0,"closed_set_candidates":0,"files_processed":0,"status":"complete"}
```

Append as final line:
`Status: COMPLETE`
