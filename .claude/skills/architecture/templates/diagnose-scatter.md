# Diagnose — Scatter

You are finding scattered operations and misplaced responsibility in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files:
- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/schemas.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/schemas.jsonl`

---

## What You Are Looking For

Every domain concept must have exactly one authoritative owner per layer. Scatter happens when the same operation — normalization, resolution, validation, creation — is implemented inline in multiple places instead of extracted to a single owner. The ADW principle: if you can't name the one file where `normalizeDomain()` lives, the concept has no owner.

Find ALL of these:

1. **Scattered operations** — the same logic appearing in 3+ places with no single owner
2. **Inlined resolution** — lookups/transformations that belong in a service but live inline in route handlers
3. **Oversized handlers** — route handlers over 150 lines that are doing service-layer work
4. **Cross-layer logic** — business logic in a layer that should only do transport (route doing data transformation, service doing DB queries directly that bypass the data layer)

---

## Step 1 — Identify Core Operations from the Inventories

From the structures, classes, and schemas inventories, extract the names of core domain operations — functions or patterns that represent significant work:
- Normalization functions (normalize*, resolve*, transform*, build*, compute*)
- Validation / gate checks (check*, verify*, validate*)
- Entity creation / update (create*, update*, upsert*)
- Dispatch / trigger patterns (dispatch*, trigger*, emit*, schedule*)

---

## Step 2 — Find Scattered Implementations

For each core operation identified:

```bash
grep -rn "{operationName}\|{OperationName}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "import\|from "
```

If an operation appears in 3+ different files with similar inline logic (not as an import of a shared function): SCATTERED.

Also search broadly for common scatter patterns:
```bash
grep -rn "normalizeDomain\|resolveProject\|resolveOrg\|normalizeUrl\|buildPayload" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each scattered operation, read every location. Note: is each location reimplementing the same logic independently? Or calling the same shared function? Independent reimplementation = SCATTER. Calling a shared function = OK.

---

## Step 3 — Find Oversized Route Handlers

```bash
find {{CODEBASE_PATH}}/src/app/api -name "route.ts" | grep -v node_modules | grep -v ".next"
```

For each route file, check its line count:
```bash
wc -l {{CODEBASE_PATH}}/src/app/api/**/route.ts
```

For any route file over 100 lines, read it. Identify what work it's doing that belongs in a service:
- Data transformations beyond simple response shaping
- Business logic / conditional branching on domain rules
- Multiple sequential DB operations
- Error handling that encodes domain knowledge

---

## Step 4 — Find Cross-Layer Logic

From the entry-points and structures inventories, check whether service functions reference DB directly rather than via a data layer:

```bash
grep -rn "db\.\|drizzle\|sql\`\|\.query(" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "prisma\.\|mongoose\.\|knex\." {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | head -20
```

Routes importing service logic is expected. Routes importing DB schema directly = layer violation.

---

## Step 5 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "architecture"
- `diagnostic_type`: "scatter"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"architecture","diagnostic_type":"scatter","severity":"CRITICAL","file_path":null,"line_number":null,"description":"SCATTERED: normalizeDomain implemented independently at 4 locations (src/a:12, src/b:45, src/c:89, src/d:203) — no single owner","recommended_action":"Extract to src/domain/normalize-domain.ts and replace all 4 inline implementations with imports","finding_signature":"334455667788990a","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"scatter","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"scattered_operations":0,"oversized_handlers":0,"cross_layer_violations":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
