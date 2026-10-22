# Inventory — Structures

You are cataloging every named domain object and data shape in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A structure is any named container for data that represents a domain concept. Unlike types (which are compile-time contracts) and schemas (which are runtime validators), structures are the actual data shapes that flow through the system at runtime.

Find ALL of these:

1. **Database row shapes** — the type a DB query returns; what Drizzle/Prisma gives you from a `select()`
2. **API request/response shapes** — the object a route handler receives or returns
3. **Service layer data transfer objects (DTOs)** — what a service function accepts and returns
4. **Domain model objects** — the core business entities (User, Conversation, Message, etc.)
5. **Configuration objects** — objects that represent app or feature config
6. **Event/message shapes** — objects that are published, queued, or emitted
7. **State objects** — shapes held in React state, Zustand stores, or similar

For each structure: where is it defined? What is its authoritative form? Where does it transform as it crosses layer boundaries? Are there parallel structures at different layers that represent the same thing but with different shapes?

---

## Step 1 — Find Domain Model Definitions

Read the types and interfaces inventory (if available) to identify which types/interfaces represent domain entities vs. utility types. Cross-reference with:

```bash
grep -rn "^export type [A-Z][A-Za-z]* = {\|^export interface [A-Z][A-Za-z]*" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Look for names that represent domain concepts: entities, records, responses, requests, events, payloads.

---

## Step 2 — Find Database Row Types

```bash
grep -rn "\$inferSelect\|\$inferInsert\|InferSelectModel\|InferInsertModel" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "typeof.*\.\$inferSelect\|Awaited<ReturnType" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | head -30
```

For each DB row type: what table does it come from? Is it used directly in the service layer, or is it transformed into a domain model first?

---

## Step 3 — Find API Request/Response Shapes

```bash
grep -rn "Request\b\|Response\b\|Payload\b\|DTO\b\|Body\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "export type\|export interface" | head -30
```

For each API shape: which route uses it? Is the shape validated by a schema? Does the same shape appear on both the frontend (what it sends) and backend (what it receives)?

---

## Step 4 — Find Service Layer Structures

Read the service files to identify what functions accept and return:

```bash
find {{CODEBASE_PATH}}/src/services -name "*.ts" | head -20
```

```bash
grep -rn "^export async function\|^export function" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | head -30
```

For each service function: what is the input type? What is the return type? Does it return the raw DB row, a transformed domain object, or an untyped structure?

---

## Step 5 — Find Cross-Layer Structure Transformations

Look for explicit mapping functions that transform one structure into another:

```bash
grep -rn "\.map(\|transform\|toDTO\|fromDB\|serialize\|deserialize\|mapTo\|fromRow" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each transformation: source structure → destination structure. Is the mapping explicit (a named function) or implicit (inline field access)?

---

## Step 6 — Find Parallel Structures (Same Concept, Multiple Shapes)

Look for types that appear to represent the same domain entity at different layers:

```bash
grep -rn "type.*User\b\|interface.*User\b\|type.*Message\b\|interface.*Message\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep "^export"
```

(Repeat for the primary domain entities identified in Steps 1–4.)

For each cluster of same-concept types at different layers: are they clearly distinguished by name (`UserRow`, `UserDTO`, `UserResponse`) or are they ambiguously named (`User` everywhere with different shapes)?

---

## Step 7 — Write the Inventory

Write one JSONL line per structure to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "structures"
- `kind`: "DOMAIN_MODEL" | "DTO" | "EVENT_SHAPE" | "STATE_SHAPE" | "VALUE_OBJECT" | "UNKNOWN"
- `name`: structure name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `category`: "domain_model" | "dto" | "event_shape" | "state_shape" | "value_object" | "unknown"
- `schema_backed`: boolean (has a corresponding validator schema)
- `schema_ref`: string | null (name of associated schema)

Example:
{"entry_type":"structures","kind":"DOMAIN_MODEL","name":"Estimate","file_path":"src/estimates/types.ts","line_number":22,"layer":"shared","is_exported":true,"is_test_file":false,"confidence":"parsed","category":"domain_model","schema_backed":true,"schema_ref":"EstimateSchema"}

After all entries:
{"_summary":true,"entry_type":"structures","total_count":N,"by_kind":{"DOMAIN_MODEL":0,"DTO":0,"EVENT_SHAPE":0,"STATE_SHAPE":0,"VALUE_OBJECT":0,"UNKNOWN":0},"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
