# Inventory — Type Operations

You are cataloging type guards, type assertions, mapped types, and conditional types in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

Type operations are compile-time constructs that transform, narrow, or compute types — they are the active mechanisms of the type system, not the passive declarations.

| Find here | Find elsewhere |
|-----------|---------------|
| `x is T` predicate functions (type guards) | `type X = ...` aliases → inventory-type-aliases |
| `function isUser(x): x is User` | `interface X` → inventory-interfaces |
| `as T` casts and `as unknown as T` double-casts | `any` / `unknown` in trusted code → inventory-type-dissolution |
| Mapped types `{ [K in keyof T]: ... }` | Schema-derived types → inventory-type-aliases |
| Conditional types `T extends U ? A : B` | |
| `keyof`, `typeof`, `infer` usage | |

---

## Step 1 — Find Type Guard Functions

```bash
grep -rn ": [a-zA-Z]* is [A-Z][A-Za-z]*\|function is[A-Z]" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each guard: what does it narrow? Is the runtime check correct — does it actually verify the structural shape it claims?

---

## Step 2 — Find Type Assertions (`as T`)

```bash
grep -rn " as [A-Z][A-Za-z]*\b\| as unknown\| as any\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "as const"
```

For each assertion, read the 3 prior lines. Classify:
- **BOUNDARY_CAST** — follows a `parse()`, `safeParse()`, or equivalent runtime validation
- **TRUST_ME_CAST** — no prior validation; compiler is told to trust unverified data
- **DOUBLE_CAST** — `as unknown as T`; always a violation

---

## Step 3 — Find Mapped and Conditional Types

```bash
grep -rn "\[K in keyof\|\[P in keyof\|extends.*?.*:.*\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

```bash
grep -rn "^export type [A-Z][A-Za-z]*<\|^type [A-Z][A-Za-z]*<" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each: is the logic readable? Mapped/conditional types that produce shapes nobody can predict from the source are candidates for explicit named types.

---

## Step 4 — Write the Inventory

Write one JSONL line per type operation to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "type_operations"
- `kind`: "TYPE_GUARD" | "BOUNDARY_CAST" | "TRUST_ME_CAST" | "DOUBLE_CAST" | "MAPPED_TYPE" | "CONDITIONAL_TYPE"
- `name`: function name or brief description (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `narrows_to`: string | null (type name being narrowed to)
- `has_runtime_check`: boolean | null (for casts — whether a parse/safeParse preceded it)

Example:
{"entry_type":"type_operations","kind":"TRUST_ME_CAST","name":"req.body as User","file_path":"src/app/api/users/route.ts","line_number":34,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","narrows_to":"User","has_runtime_check":false}

After all entries:
{"_summary":true,"entry_type":"type_operations","total_count":N,"by_kind":{"TYPE_GUARD":0,"BOUNDARY_CAST":0,"TRUST_ME_CAST":0,"DOUBLE_CAST":0,"MAPPED_TYPE":0,"CONDITIONAL_TYPE":0},"trust_me_cast_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
