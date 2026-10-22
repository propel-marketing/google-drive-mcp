# Inventory — Domain Models

You are cataloging every named domain entity in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

A domain model is a named concept that represents a core business entity. It is the vocabulary of the domain.

| Find here | Find elsewhere |
|-----------|---------------|
| Core business entities (User, Order, Estimate, Conversation) | API request/response shapes → inventory-data-transfer-objects |
| DB row types derived from ORM schema | Event and message payloads → inventory-event-shapes |
| Named value objects (Money, Address, DateRange) | UI state shapes → inventory-state-shapes |
| Aggregate roots with identity (has an `id` field) | Type aliases and utility types → inventory-type-aliases |

---

## Step 1 — Find Domain Entity Declarations

```bash
grep -rn "^export type [A-Z][A-Za-z]* = {\|^export interface [A-Z][A-Za-z]*" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each candidate, read the full declaration. A domain entity:
- Has a meaningful business name (not `Response`, `Payload`, `Data`, `Options`)
- Typically has an `id` field (aggregate root) or represents a value concept
- Maps to something a domain owner would recognize

---

## Step 2 — Find DB Row Types (ORM-Derived)

```bash
grep -rn "\$inferSelect\|\$inferInsert\|InferSelectModel\|InferInsertModel" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "Awaited<ReturnType.*db\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | head -20
```

For each DB row type: does it serve directly as the domain model, or is it transformed into a separate domain type before reaching the service layer?

---

## Step 3 — Find Cross-Layer Variants

For each domain entity found, search for layered variants (Row, DTO, Response forms):

```bash
grep -rn "type.*User\b\|interface.*User\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep "^export"
```

Repeat for each core domain entity name. Build a cluster for each concept showing all its forms.

---

## Step 4 — Write the Inventory

Write one JSONL line per domain model to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "domain_models"
- `kind`: "AGGREGATE_ROOT" | "VALUE_OBJECT" | "DB_ROW" | "ENTITY"
- `name`: entity name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `has_id_field`: boolean
- `schema_backed`: boolean (has a corresponding runtime schema)
- `schema_ref`: string | null
- `layer_variant_count`: integer (how many layered forms exist: Row, DTO, Response, etc.)

Example:
{"entry_type":"domain_models","kind":"AGGREGATE_ROOT","name":"User","file_path":"src/users/types.ts","line_number":8,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","has_id_field":true,"schema_backed":true,"schema_ref":"UserSchema","layer_variant_count":3}

After all entries:
{"_summary":true,"entry_type":"domain_models","total_count":N,"by_kind":{"AGGREGATE_ROOT":0,"VALUE_OBJECT":0,"DB_ROW":0,"ENTITY":0},"schema_backed_count":0,"multi_variant_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
