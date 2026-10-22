# Inventory — Magic Strings

You are cataloging every inline string literal used in conditional logic in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A magic string is a string literal used directly in comparisons or switches without being declared as a named constant or enum. Magic strings scatter the vocabulary of the domain across multiple files and make renaming dangerous.

```typescript
// Magic string (violation)
if (status === 'pending') { ... }
if (user.role === 'admin') { ... }

// Named constant (correct)
if (status === OrderStatus.PENDING) { ... }
if (user.role === Role.ADMIN) { ... }
```

---

## Step 1 — Find String Comparisons

```bash
grep -rn "=== '[a-z_-]\|=== \"[a-z_-]\|!== '[a-z_-]\|!== \"[a-z_-]" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sort | uniq -c | sort -rn | head -40
```

```bash
grep -rn "switch.*'\|case '.*':" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

---

## Step 2 — Find Repeated Literals (De-Facto Enums)

```bash
grep -rn "=== '" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sed "s/.*=== '//; s/'.*//" | sort | uniq -c | sort -rn | head -20
```

Literals appearing 3+ times in comparisons are de-facto enum values without a declaration. List these as clusters.

---

## Step 3 — Check for Existing Named Constants

For each repeated literal found, check if a named constant or enum already exists:

```bash
grep -rn "'pending'\|'active'\|'inactive'" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "==="
```

If a constant exists in one place but is used as a literal in others: the constant is not being used consistently.

---

## Step 4 — Write the Inventory

Write one JSONL line per magic string site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "magic_strings"
- `kind`: "STRING_COMPARISON" | "SWITCH_CASE" | "OBJECT_KEY" | "ARRAY_MEMBER"
- `name`: the literal value (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `occurrence_count`: integer (total times this value appears in comparisons across the codebase)
- `has_named_constant`: boolean (a constant or enum declaring this value exists somewhere)
- `constant_ref`: string | null (name of the constant/enum if it exists)

Example:
{"entry_type":"magic_strings","kind":"STRING_COMPARISON","name":"pending","file_path":"src/orders/handlers.ts","line_number":34,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","occurrence_count":7,"has_named_constant":false,"constant_ref":null}

After all entries:
{"_summary":true,"entry_type":"magic_strings","total_count":N,"unique_values":0,"with_named_constant":0,"without_named_constant":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
