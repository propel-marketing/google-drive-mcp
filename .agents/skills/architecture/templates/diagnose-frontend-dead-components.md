# Diagnose — Frontend Dead Components

You are diagnosing dead (unreferenced) components in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Every component should have at least one importer or be a route entry point. A component with zero importers is dead code — it inflates the codebase, confuses future builders, and may contain stale behavior. This mirrors the backend dead-code diagnostic applied to the frontend layer.

---

## Step 1 — Load Upstream Inventory

Read `{{PRIOR_FILE_1}}` (frontend components inventory). Parse each JSONL record, skipping `_summary` lines.

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"frontend_components inventory is empty — no components to evaluate"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Identify Zero-Importer Candidates

From the inventory, collect all records where `importer_count == 0`. These are dead component candidates.

---

## Step 3 — Verify: Check for Route Entry Usage

A component may have zero static importers but still be a dynamic route entry (e.g., a Next.js page at `app/dashboard/page.tsx` or `pages/dashboard.tsx`). Check each candidate:

```bash
# Is it in an app/ or pages/ directory? (route entries don't need importers)
echo "{{FILE_PATH}}" | grep -E '^(src/)?(app|pages)/'
```

Also check for dynamic imports:
```bash
grep -rn "dynamic.*{{COMPONENT_NAME}}\|import('.*{{COMPONENT_FILE}}')" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules
```

Remove from dead list any component that is a route entry or is dynamically imported.

---

## Step 4 — Verify: Check for Re-Export Patterns

Some components are re-exported via barrel index files:

```bash
grep -rn "{{COMPONENT_NAME}}" {{CODEBASE_PATH}}/src --include='index.ts' --include='index.tsx' 2>/dev/null | grep -v node_modules
```

If a component is re-exported, its direct importer count may be 0 but it's still live.

---

## Step 5 — Write Findings

For each confirmed dead component (zero importers, not a route entry, not re-exported), write a finding:

```markdown
### Finding N — Dead component: <ComponentName>
- **severity:** MAJOR
- **principle:** Every component should have at least one importer or be a route entry
- **location:** path/to/DeadComponent.tsx:1
- **description:** `<ComponentName>` has 0 importers and is not a route entry or dynamically imported. It is dead code.
- **evidence:** `grep -rn "ComponentName" src/` returns only the component file itself
- **remediation:**
  - **action:** Delete `path/to/DeadComponent.tsx` — confirm no dynamic import or barrel export before deletion
  - **files:** [DELETE path/to/DeadComponent.tsx]
  - **acceptance:** `grep -rn "ComponentName" src/` returns 0 results
  - **effort:** XS
```

---

## Step 6 — Write Summary

The last line of `{{OUTPUT_PATH}}` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"components_total":N,"dead_confirmed":N,"route_entries_excluded":N,"dynamic_imports_excluded":N}
```

---

Status: COMPLETE
