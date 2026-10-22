# Inventory — Frontend Hooks

You are cataloging every custom hook in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every custom React hook — functions starting with `use` that encapsulate stateful logic, side effects, or data fetching. Hooks are first-class architectural units: they own behavior the same way services own backend logic. A hook with no callers is dead code; a hook doing too much is a responsibility violation.

Read `{{CODEBASE_PATH}}/package.json` first to confirm the framework.

---

## Step 1 — Find All Custom Hooks

```bash
grep -rEn '^(export )?(function|const) use[A-Z]' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

---

## Step 2 — Check Caller Count

For each hook, count how many files import or call it:

```bash
grep -rn "use{{HOOK_NAME}}\b" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -v "{{HOOK_FILE}}" | wc -l
```

Record as `caller_count`. Zero = dead hook candidate.

---

## Step 3 — Check Return Type

For each hook file, check whether the return type is explicitly typed:

```bash
grep -n "): [A-Z]\|: {" {{HOOK_FILE}} | head -3
```

Record `return_typed` as boolean.

---

## Step 4 — Measure Size

```bash
wc -l < {{HOOK_FILE}}
```

Record `size_loc`. Hooks over 150 LOC are doing too much — flag as `oversized`.

---

## Step 5 — Write the Inventory

Write one JSONL line per hook to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `entry_type`: "frontend_hooks"
- `name`: hook name (string, e.g. "useUserData")
- `file_path`: path relative to codebase root
- `line_number`: integer
- `kind`: "data_fetching" | "state_management" | "side_effect" | "utility" | "unknown"
- `caller_count`: integer
- `return_typed`: boolean
- `size_loc`: integer
- `oversized`: boolean (size_loc > 150)
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
```json
{"entry_type":"frontend_hooks","name":"useUserData","file_path":"src/hooks/useUserData.ts","line_number":8,"kind":"data_fetching","caller_count":3,"return_typed":true,"size_loc":42,"oversized":false,"is_test_file":false,"confidence":"parsed"}
```

After all entries, write the summary:
```json
{"_summary":true,"entry_type":"frontend_hooks","total_count":N,"dead_candidates":0,"oversized_count":0,"untyped_count":0,"status":"complete"}
```

If no hooks found after exhaustive search:
```json
{"_summary":true,"entry_type":"frontend_hooks","total_count":0,"status":"empty"}
```

---

Status: COMPLETE
