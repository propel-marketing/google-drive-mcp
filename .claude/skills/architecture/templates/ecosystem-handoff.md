# Ecosystem Handoff

You are writing audit metadata for **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Write JSON output to: `{{OUTPUT_PATH}}`

Downstream skills read the raw inventory and synthesis files directly from `{{OUTPUT_DIR}}`. This artifact records only what cannot be derived from those files: tech stack and audit coordinates.

---

## Step 1 — Read Tech Stack from package.json

```bash
cat "{{CODEBASE_PATH}}/package.json" 2>/dev/null
```

From `dependencies` and `devDependencies`, identify:
- `framework` — e.g. `next`, `express`, `fastify`, `hono`, `nestjs` (first match wins)
- `language` — `typescript` if `typescript` in devDependencies, else `javascript`
- `database` — e.g. `drizzle-orm`, `prisma`, `mongoose`, `pg`, `mysql2` (first match wins)
- `frontend` — e.g. `react`, `vue`, `svelte` (first match wins; null if none)

If package.json is absent, set all fields to null.

---

## Step 2 — Write JSON

Write this JSON object to `{{OUTPUT_PATH}}`:

```json
{
  "schema_version": "1.1",
  "codebase": "{{CODEBASE_NAME}}",
  "feature": "{{FEATURE_NAME}}",
  "audit_date": "{{DATE_SLUG}}",
  "output_dir": "{{OUTPUT_DIR}}",
  "tech_stack": {
    "framework": "<derived or null>",
    "language": "<derived or null>",
    "database": "<derived or null>",
    "frontend": "<derived or null>"
  },
  "inventory_dir": "{{OUTPUT_DIR}}/inventory",
  "diagnose_dir": "{{OUTPUT_DIR}}/diagnose",
  "plan_dir": "{{OUTPUT_DIR}}/plan",
  "downstream_skill_hint": "Read inventory JSONL files from inventory_dir and synthesis markdown from plan_dir directly — full fidelity data lives there."
}
```

Rules:
- Valid JSON only — use `null`, not the string `"null"`
- No `_summary` line — this file is pure JSON

---

## Step 3 — Append Status Marker

```
Status: COMPLETE
```
