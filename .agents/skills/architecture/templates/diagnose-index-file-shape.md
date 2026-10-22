# Diagnose — Index File Shape

You are checking that every index file is either a clean barrel or a composition root in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read this inventory file:
- `{{INV_DIR}}/file-structure.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory file listed above. It must end with `Status: COMPLETE`.
If the inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/file-structure.jsonl`

---

## What This Diagnostic Proves

The conventional folder-entry filename has two valid shapes — and they look opposite:

- **Barrel index** — small (1–11 lines for TS, 1–20 for sparser languages). Re-exports the public surface of its folder. No logic. Single purpose: give consumers one import target so the folder's internals can change without breaking anyone.
- **Composition root** — large (1000+ lines). Wires the entire system: instantiates dependencies, configures registries, registers capabilities, starts the runtime. Large because it has to know about every module in order to compose them.

A "medium-sized" index file (50–500 lines) is almost always wrong. Too big to be a clean barrel; too small to be a composition root. Usually means logic has leaked into a barrel, or a composition root is partially extracted but not finished.

---

## Step 1 — Find Every Index File

```bash
find {{CODEBASE_PATH}}/src -type f \( -name "index.ts" -o -name "index.js" -o -name "index.tsx" -o -name "__init__.py" -o -name "mod.rs" -o -name "lib.rs" \) | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each index file, capture the line count:

```bash
find {{CODEBASE_PATH}}/src -type f -name "index.ts" | grep -v node_modules | grep -v ".next" | xargs wc -l | sort -n
```

---

## Step 2 — Classify Each Index File by Shape

For each index file:

### Barrel test — read the file. Is every line one of:
- An `export ... from ...` re-export
- An `export type ... from ...` type re-export
- An `export { ... } from ...` named re-export
- A blank line or comment

If every line matches: **BARREL_CLEAN**.

If the file contains function declarations, class definitions, runtime values, or imports of runtime modules (not just types): **BARREL_LEAKED**.

### Composition root test — read the file. Is its purpose to wire the system?
- Imports from many modules
- Constructs instances or registers capabilities
- Starts a runtime, server, or app

If yes and over 500 lines: **COMPOSITION_ROOT**.
If yes but under 500 lines: **COMPOSITION_ROOT_PARTIAL** — partially extracted; still has leakage in original sites.

### The middle zone

If neither barrel nor composition root, and 50–500 lines: **MEDIUM_VIOLATION**. This is the wrong shape.

---

## Step 3 — Diagnose Each Violation

For each BARREL_LEAKED:
- What logic leaked in?
- Which file should it move to?
- Is the leakage substantial enough to require extraction, or is it a single line that should just move?

For each COMPOSITION_ROOT_PARTIAL:
- What is in this file vs. what is still in other places?
- What should be consolidated?

For each MEDIUM_VIOLATION:
- Is it trying to be a barrel that crept logic in? → Extract logic, restore to barrel.
- Is it trying to be a composition root but undersized? → Find what's missing; consolidate.
- Is it neither? → It's misnamed; rename to a verb-noun describing what it actually does.

---

## Step 4 — Check Barrel Coverage

For each domain folder, verify whether a barrel exists.

```bash
ls -d {{CODEBASE_PATH}}/src/*/ 2>/dev/null | while read dir; do
  if [ ! -f "$dir/index.ts" ] && [ ! -f "$dir/index.tsx" ]; then
    echo "MISSING BARREL: $dir"
  fi
done
```

A domain folder without a barrel forces every consumer to know the folder's internal layout. Refactoring becomes risky because every internal file is a potential import target. Flag missing barrels for domain folders (infrastructure folders may not need them).

---

## Step 5 — Check Composition Root Singularity

How many composition roots exist in the codebase?

- **One** (typically `src/index.ts` or `src/main.ts`) — correct.
- **One per deployable** (e.g., `src/api/index.ts`, `src/worker/index.ts`) — correct for multi-deploy systems.
- **More than one per deployable** — fragmentation. Composition is scattered.

For each composition root, list it. If multiple exist that should be one, this is a consolidation opportunity.

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "structure"
- `diagnostic_type`: "index_file_shape"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"structure","diagnostic_type":"index_file_shape","severity":"MAJOR","file_path":"src/payments/index.ts","line_number":15,"description":"BARREL_LEAKED: barrel contains getPaymentByIntent() function — logic in barrel breaks refactoring safety","recommended_action":"Extract getPaymentByIntent to src/payments/lookup.ts; restore index.ts to re-exports only","finding_signature":"1122334455667788","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"index_file_shape","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"barrel_clean_count":0,"medium_violation_count":0,"status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [file] — MEDIUM_VIOLATION — [extract logic | consolidate | rename]
2. [file] — BARREL_LEAKED — [extract specific function]
3. [domain] — missing barrel — add re-exports
```

---

Append as final line:
`Status: COMPLETE`
