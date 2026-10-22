# Diagnose — Frontend Component Size Distribution

You are diagnosing oversized component violations in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Components over 300 LOC are doing too much — they own rendering logic, data-fetching logic, and business logic simultaneously. This mirrors the backend size-distribution principle: file size signals responsibility scope. A 300+ LOC component should be split into a container (data) and presentational (render) pair, or broken into subcomponents.

---

## Step 1 — Load Upstream Inventory

Read `{{PRIOR_FILE_1}}` (frontend components inventory). Parse each JSONL record, skipping `_summary` lines.

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"frontend_components inventory is empty — no components to evaluate"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Compute Size Distribution

From the inventory records, extract `size_loc` for all components. Compute:
- Count of components in each zone:
  - **Under 150 LOC** — healthy
  - **150–300 LOC** — monitor (MINOR)
  - **300–500 LOC** — oversized (MAJOR)
  - **Over 500 LOC** — severely oversized (MAJOR, escalates to CRITICAL if it also has no typed props)

---

## Step 3 — Verify Sizes for MAJOR+ Candidates

For each component with `size_loc > 300`, verify the count and scan for mixed concerns:

```bash
wc -l < {{CODEBASE_PATH}}/{{FILE_PATH}}
```

```bash
grep -c 'useQuery\|useSWR\|fetch(\|axios\.' {{CODEBASE_PATH}}/{{FILE_PATH}}
```

```bash
grep -c 'useState\|useReducer\|useEffect' {{CODEBASE_PATH}}/{{FILE_PATH}}
```

A component with data-fetching, local state, AND 300+ LOC of JSX is a clear split candidate.

---

## Step 4 — Write Findings

For each MAJOR/MINOR violation, write a markdown finding block to `{{OUTPUT_PATH}}`:

```markdown
### Finding N — Oversized component: <ComponentName> (N LOC)
- **severity:** MAJOR | MINOR
- **principle:** Components over 300 LOC should be split into container + presentational pair
- **location:** path/to/Component.tsx:1
- **description:** `<ComponentName>` is N LOC and mixes data fetching, state management, and render logic.
- **evidence:** wc -l = N; useQuery calls = N; useState calls = N
- **remediation:**
  - **action:** Extract data-fetching into a `use<ComponentName>Data` hook; split render into subcomponents under `<ComponentName>/`
  - **files:** [CREATE src/hooks/use<ComponentName>Data.ts, EDIT path/to/Component.tsx]
  - **acceptance:** `wc -l src/components/<ComponentName>.tsx` returns < 150
  - **effort:** M | L
```

---

## Step 5 — Write Summary

The last line of `{{OUTPUT_PATH}}` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"components_total":N,"healthy_count":N,"monitor_count":N,"oversized_count":N,"severely_oversized_count":N,"p50_loc":N,"p90_loc":N}
```

---

Status: COMPLETE
