# Diagnose — Trace

You are tracing the 3 most important data structures in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` from origin to consumption.

Read these inventory files:
- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/entry-points.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/entry-points.jsonl`

---

## What You Are Looking For

A type can exist in the inventory and still dissolve in practice. The question is not "does this type exist?" — it is "does this type maintain its identity as data moves through the system?"

For each structure, trace its complete journey: created or received at the boundary, transformed through layers, consumed or returned. At every step, ask: what type does this data carry? If it was `ConversationRow` at step 1, is it still `ConversationRow` at step 3, or did it become `any`, `Record<string, unknown>`, or an anonymous destructured shape?

---

## Step 1 — Identify the 3 Core Structures

From the structures, schemas, and entry-points inventories, identify the 3 most central data structures in this feature. Choose by:
- Volume of references (appears across many files)
- Layer span (travels from DB through service to API)
- Business criticality (the primary request payload, primary DB entity, primary response shape)

Name each structure using its canonical name from the inventory files.

---

## Step 2 — Trace Each Structure

For each of the 3 structures:

**Find all references:**
```bash
grep -rn "{StructureName}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Read each file:line found. Determine what is happening at that location — is this where the structure is created, transformed, passed to another function, returned, or consumed?

**Build the journey step by step:**

For each step in order (by data flow, not file path):

| Step | File | Line | Action | Type Carried | Identity Status |
|------|------|------|--------|-------------|----------------|
| 1 | src/db/schema.ts | 45 | Defined as DB row | ConversationRow | NAMED |
| 2 | src/services/ai/service.ts | 112 | Returned from db.select() | unknown (no annotation) | DISSOLVED |
| 3 | src/services/ai/service.ts | 115 | Cast via `as ConversationRow` | ConversationRow | NAMED (cast) |
| 4 | src/app/api/chat/route.ts | 78 | Destructured anonymously | { id, content } | DISSOLVED |

**Identity Status values:**
- `NAMED` — carries its canonical type name, visible from the code
- `NAMED (cast)` — named via explicit cast (`as Type`) — acceptable but note it
- `NAMED (inferred)` — TypeScript infers the correct type without annotation
- `DISSOLVED` — lost its type name: became `any`, `unknown`, anonymous object, or generic `Record<>`
- `DISSOLVED (cast)` — explicitly cast away from its type (`as any`, `as Record<string, unknown>`)

---

## Step 3 — Flag Dissolution Points

For each `DISSOLVED` or `DISSOLVED (cast)` step:

```
### Dissolution: {StructureName} at {file:line}

Mechanism: `as any` | anonymous destructuring | untyped DB result | JSON.parse | other
What was lost: [the type name and what it carried]
Downstream impact: [what code receives the dissolved data — list file:line for each]
Severity: BLOCKER | MAJOR | MINOR

BLOCKER: any dissolution at an external boundary or before a DB write
MAJOR: dissolution in service layer trusted code
MINOR: dissolution in a transformation that's immediately re-typed
```

---

## Step 4 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "type_safety"
- `diagnostic_type`: "trace"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Emit one INFO finding per traced structure (with thread_coherence, dissolution_count) and one finding per dissolution point found.

Example (structure summary):
{"category":"type_safety","diagnostic_type":"trace","severity":"INFO","file_path":null,"line_number":null,"description":"TRACE: ConversationRow — thread PARTIAL (2 dissolution points) — DB→service→API span","recommended_action":null,"finding_signature":"66778899aabbcc00","confidence":"ai_judged"}

Example (dissolution finding):
{"category":"type_safety","diagnostic_type":"trace","severity":"MAJOR","file_path":"src/services/ai/service.ts","line_number":112,"description":"DISSOLVED: ConversationRow returned from db.select() without type annotation — becomes unknown before downstream cast","recommended_action":"Annotate the return type of the db.select() call or use Drizzle's inferred type","finding_signature":"778899aabbccdd00","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"trace","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"structures_traced":3,"dissolution_points":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
