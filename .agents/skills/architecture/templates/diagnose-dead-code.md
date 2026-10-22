# Diagnose — Dead Code

You are finding dead exports, uncaught error classes, and shipped stubs in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files:
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/structures.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/structures.jsonl`

---

## What You Are Looking For

Dead code is a documentation lie. An exported function that is never called promises a capability the system doesn't use. An error class thrown at 9 sites but caught at 0 is a silent failure factory. A stub function that ships to production promises behavior that never executes.

Find ALL of these:

1. **Dead exports** — exported symbols (functions, types, classes, constants) with zero importers across the codebase
2. **Uncaught error classes** — error classes thrown at N sites but caught specifically at 0 sites (caught only as generic `Error` or not at all)
3. **Stub functions** — functions with empty bodies, `// TODO`, `throw new Error('not implemented')`, or a single placeholder return
4. **Unused imports** — imported symbols that are never referenced in the importing file
5. **Dead feature flags** — constants or config values that are defined but never read

---

## Step 1 — Find Error Classes and Their Catch Coverage

From the classes inventory, extract all classes with `kind: ERROR`.

For each error class:

```bash
grep -rn "throw new {ErrorClassName}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "catch.*{ErrorClassName}\| instanceof {ErrorClassName}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next"
```

Classify each error class:
- **THROW_ONLY** — thrown at N sites, specifically caught at 0 (only caught as generic `Error` or swallowed)
- **COVERED** — thrown at N sites, specifically caught at M sites (M > 0)
- **DEAD** — never thrown anywhere

---

## Step 2 — Find Dead Exported Symbols

From the classes, schemas, and structures inventories, collect exported symbol names.

For each exported function, class, or schema:

```bash
grep -rn "import.*{SymbolName}\|from.*{SymbolName}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "^{SymbolFile}"
```

Zero results outside the defining file = DEAD export.

Also scan broadly:
```bash
grep -rn "^export function\|^export const\|^export class\|^export async function" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -i "{{FEATURE_NAME}}\|data-hub\|datahub"
```

For each export found, check for callers.

---

## Step 3 — Find Stub Functions

```bash
grep -rn "throw new Error('not implemented')\|throw new Error(\"not implemented\")\|\/\/ TODO\|\/\/ FIXME\|\/\/ STUB" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "=> {}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each stub: read the surrounding function. Is this a stub that ships to production and promises behavior that never executes? Or a legitimate no-op (empty event handler, intentional passthrough)?

---

## Step 4 — Find Unused Imports

```bash
grep -rn "^import " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -i "{{FEATURE_NAME}}" | head -40
```

For suspicious imports (types imported from one place but used from another, or imports that look like leftovers), check whether the imported symbol appears in the file body.

---

## Step 5 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "code_quality"
- `diagnostic_type`: "dead_code"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"code_quality","diagnostic_type":"dead_code","severity":"MAJOR","file_path":"src/lib/data-utils.ts","line_number":89,"description":"buildStaleFallback is exported but has zero callers across the codebase","recommended_action":"Confirm intent; if no longer needed, delete the export","finding_signature":"b2c3d4e5f6071122","confidence":"pattern_matched"}

After all findings:
{"_summary":true,"diagnostic_type":"dead_code","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
