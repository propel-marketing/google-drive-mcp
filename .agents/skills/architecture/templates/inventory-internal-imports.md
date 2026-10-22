# Inventory — Internal Imports

You are cataloging the import dependency graph between files within the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Internal imports reveal the actual dependency structure of the codebase — which modules depend on which, whether layers are respected, and whether any domain boundaries are being violated.

Find and assess ALL of these:
1. **Layer violations** — a lower layer importing from a higher layer (e.g., DB layer importing from service layer)
2. **Circular dependencies** — A imports B imports A
3. **Deep relative paths** — `../../../../` indicating a missing abstraction or wrong file placement
4. **Cross-domain imports** — one feature domain importing from another (coupling)

---

## Step 1 — Map Internal Import Patterns

```bash
grep -rn "^import\|^export.*from" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep "'\.\./\|\"\.\./" | head -60
```

Count occurrences of deep relative paths:
```bash
grep -rn "'\.\./\.\./\.\./\|\"\.\.\/\.\.\/" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | wc -l
```

---

## Step 2 — Find Layer Violations

The expected dependency direction (from higher to lower):
`routes/handlers → services → db/data-layer → shared/types`

```bash
grep -rn "from.*\/services\/" {{CODEBASE_PATH}}/src/db --include="*.ts" | grep -v node_modules | grep -v ".next" | head -10
```

```bash
grep -rn "from.*\/db\/" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep "\/app\/api\|\/handlers\|\/routes" | head -10
```

A `db/` file importing from `services/` is a layer inversion. A route file importing directly from `db/` skips the service layer.

---

## Step 3 — Find Cross-Domain Coupling

```bash
grep -rn "^import\|^export.*from" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep "'\.\.\/" | grep -v "types\|utils\|shared\|common\|lib" | head -40
```

For each cross-domain import: is the coupling necessary, or should it flow through a shared interface?

---

## Step 4 — Find Barrel vs. Deep Imports

```bash
grep -rn "from '.*\/index'\|from \".*\/index\"" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | head -20
```

```bash
grep -rn "from '.*\/src\/" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | head -20
```

Deep imports bypass barrel files and create fragile dependencies on internal file locations.

---

## Step 5 — Write the Inventory

Write one JSONL line per import relationship to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Focus on noteworthy imports (violations, deep paths, cross-domain) rather than every import.

Common fields (required):
- `entry_type`: "internal_imports"
- `kind`: "LAYER_VIOLATION" | "CROSS_DOMAIN" | "DEEP_RELATIVE" | "BARREL" | "DIRECT" | "CIRCULAR"
- `name`: imported module path (string)
- `file_path`: path of the importing file (relative to codebase root)
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `import_target`: string (the module being imported, relative path)
- `depth`: integer (number of `../` segments)
- `is_flagged`: boolean

Example:
{"entry_type":"internal_imports","kind":"LAYER_VIOLATION","name":"../services/user-service","file_path":"src/db/queries.ts","line_number":3,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","import_target":"../services/user-service","depth":1,"is_flagged":true}

After all entries:
{"_summary":true,"entry_type":"internal_imports","total_flagged":N,"by_kind":{"LAYER_VIOLATION":0,"CROSS_DOMAIN":0,"DEEP_RELATIVE":0,"BARREL":0,"DIRECT":0,"CIRCULAR":0},"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
