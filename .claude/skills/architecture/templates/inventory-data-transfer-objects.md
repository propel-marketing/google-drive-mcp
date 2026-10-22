# Inventory — Data Transfer Objects

You are cataloging every API request/response shape and cross-layer DTO in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

A DTO is any type whose primary purpose is to transfer data across a layer boundary — between HTTP and application logic, between service and caller, between process and queue.

| Find here | Find elsewhere |
|-----------|---------------|
| API request bodies (`CreateUserInput`, `UpdateOrderBody`) | Core business entities → inventory-domain-models |
| API response shapes (`UserResponse`, `OrderListResponse`) | Event/message payloads → inventory-event-shapes |
| Service layer input/output types | State shapes in UI stores → inventory-state-shapes |
| Form data types | Runtime validators → inventory-schemas |

---

## Step 1 — Find API Request/Response Types

```bash
grep -rn "Request\b\|Response\b\|Payload\b\|DTO\b\|Body\b\|Input\b\|Output\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "export type\|export interface" | head -40
```

For each: identify which route or endpoint uses it. Is the shape validated at the boundary?

---

## Step 2 — Find Service Layer Input/Output Types

```bash
grep -rn "^export async function\|^export function" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | head -30
```

For each service function signature, identify its input type and return type. Are these named types or anonymous inline shapes?

---

## Step 3 — Check Schema Coverage

For each DTO found, check whether a corresponding schema exists:

```bash
grep -rn "{TypeName}Schema\|Schema.*{TypeName}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

A DTO that crosses a boundary without a schema is an unguarded entry point — see inventory-entry-points.

---

## Step 4 — Write the Inventory

Write one JSONL line per DTO to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "data_transfer_objects"
- `kind`: "API_REQUEST" | "API_RESPONSE" | "SERVICE_INPUT" | "SERVICE_OUTPUT" | "FORM_DATA" | "QUEUE_MESSAGE"
- `name`: type name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `direction`: "inbound" | "outbound" | "bidirectional" | "internal"
- `schema_backed`: boolean
- `schema_ref`: string | null
- `boundary_ref`: string | null (route path or service name where this DTO is used)

Example:
{"entry_type":"data_transfer_objects","kind":"API_REQUEST","name":"CreateUserInput","file_path":"src/users/types.ts","line_number":15,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","direction":"inbound","schema_backed":true,"schema_ref":"CreateUserSchema","boundary_ref":"POST /api/users"}

After all entries:
{"_summary":true,"entry_type":"data_transfer_objects","total_count":N,"by_kind":{"API_REQUEST":0,"API_RESPONSE":0,"SERVICE_INPUT":0,"SERVICE_OUTPUT":0,"FORM_DATA":0,"QUEUE_MESSAGE":0},"unguarded_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
