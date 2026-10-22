# Inventory — Type Aliases

You are cataloging every `type X = ...` declaration in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

| Find here | Find elsewhere |
|-----------|---------------|
| `type X = string \| number` (scalar aliases) | `interface X { ... }` → inventory-interfaces |
| `type X = 'a' \| 'b'` (string literal unions) | Closed value sets with `enum` keyword → inventory-enums |
| `type X = Pick<Y, 'a'>` (utility type applications) | Type guard predicates → inventory-type-operations |
| `type X = z.infer<typeof Y>` (schema-derived) | Runtime `as T` casts → inventory-type-dissolution |
| `type X = { a: string }` (inline object shapes) | Named domain entities → inventory-domain-models |
| `type X = A & B` (intersections) | |
| `type X<T> = ...` (generic aliases) | |

---

## Step 1 — Find All Type Alias Declarations

```bash
grep -rn "^export type [A-Z][A-Za-z]* =\|^type [A-Z][A-Za-z]* =" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each declaration, read its full definition. Categorize:
- **Scalar alias** — `type UserId = string`
- **String literal union** — `type Status = 'active' | 'inactive'`
- **Object shape** — `type Config = { key: string; value: number }`
- **Utility application** — `type Partial<User>`, `Pick<User, 'id' | 'email'>`
- **Intersection** — `type AdminUser = User & AdminPermissions`
- **Schema-derived** — `type User = z.infer<typeof UserSchema>`
- **Generic** — `type Result<T> = { data: T; error: string | null }`

---

## Step 2 — Find Re-exported Type Aliases

```bash
grep -rn "^export type {" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each re-export: how many hops to reach the definition? Any module re-exporting a type it does not own is a potential drift risk.

---

## Step 3 — Find Duplicate Type Names

```bash
grep -rn "^export type [A-Z][A-Za-z]*\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sed 's/.*export type //' | awk -F'[ =<]' '{print $1}' | sort | uniq -d
```

---

## Step 4 — Write the Inventory

Write one JSONL line per type alias to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "type_aliases"
- `kind`: "SCALAR_ALIAS" | "STRING_UNION" | "OBJECT_SHAPE" | "UTILITY_APPLICATION" | "INTERSECTION" | "SCHEMA_DERIVED" | "GENERIC"
- `name`: type name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `is_schema_derived`: boolean
- `schema_source`: string | null
- `is_re_exported`: boolean
- `has_duplicate_name`: boolean

Example:
{"entry_type":"type_aliases","kind":"SCALAR_ALIAS","name":"UserId","file_path":"src/users/types.ts","line_number":3,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","is_schema_derived":false,"schema_source":null,"is_re_exported":false,"has_duplicate_name":false}

After all entries:
{"_summary":true,"entry_type":"type_aliases","total_count":N,"by_kind":{"SCALAR_ALIAS":0,"STRING_UNION":0,"OBJECT_SHAPE":0,"UTILITY_APPLICATION":0,"INTERSECTION":0,"SCHEMA_DERIVED":0,"GENERIC":0},"re_exported_count":0,"duplicate_name_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
