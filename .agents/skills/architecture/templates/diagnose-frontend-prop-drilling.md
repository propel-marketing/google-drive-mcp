# Diagnose — Frontend Prop Drilling

You are diagnosing prop drilling violations in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Props passed more than 2 levels without transformation should use context or a store. Prop drilling is a responsibility distribution violation — the intermediate component is acting as a pass-through with no ownership of the data.

---

## Step 1 — Load Upstream Inventory

Read `{{PRIOR_FILE_1}}` (frontend components inventory). Parse each JSONL record, skipping `_summary` lines.

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"frontend_components inventory is empty — no components to evaluate"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Identify Prop-Passing Chains

For each component with `importer_count > 0`, check its props interface for props that look like they belong to a grandchild (not the component itself):

```bash
grep -n "Props\|props\." {{CODEBASE_PATH}}/{{FILE_PATH}} | head -30
```

Then check whether those same prop names are passed down:
```bash
grep -n "{{PROP_NAME}}={" {{CODEBASE_PATH}}/{{FILE_PATH}} | head -10
```

A component is a drilling candidate if it receives a prop and immediately passes it to a child without using it in its own render logic.

---

## Step 3 — Verify Depth

For confirmed drilling candidates, trace the chain: source component → intermediate → consumer. Count hops. Only flag chains with 3+ levels (prop passes through ≥2 intermediate components without transformation).

---

## Step 4 — Write Findings

For each violation found, write a markdown finding block to `{{OUTPUT_PATH}}`:

```markdown
### Finding N — Prop drilled across N levels: <PropName>
- **severity:** MAJOR
- **principle:** Props passed >2 levels without transformation should use context or store
- **location:** path/to/IntermediateComponent.tsx:LINE
- **description:** `<PropName>` passes through N components (A → B → C) without being used or transformed by the intermediate components.
- **evidence:** grep showing prop defined in A, passed in B, consumed in C
- **remediation:**
  - **action:** Extract `<PropName>` into a context provider or store; remove intermediate prop threading
  - **files:** [CREATE src/context/PropNameContext.tsx, EDIT path/to/A.tsx, EDIT path/to/B.tsx]
  - **acceptance:** `grep -rn "<PropName>=" src/` shows only the context provider and final consumer
  - **effort:** S
```

If no violations found, write a note:
```markdown
### No prop drilling violations found
All props are consumed within 2 levels of their source.
```

---

## Step 5 — Write Summary

The last line of `{{OUTPUT_PATH}}` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"components_evaluated":N,"drilling_chains_found":N}
```

---

Status: COMPLETE
