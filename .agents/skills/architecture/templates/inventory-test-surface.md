# Inventory — Test Surface

You are cataloging the test surface of the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}` — computing expected vs actual test coverage for every significant code unit.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`
Read the upstream inventory from: `{{PRIOR_FILE_2}}`
Read the upstream inventory from: `{{PRIOR_FILE_3}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

For every code unit that matters (routes, services, utilities, components), determine:
1. What test kinds SHOULD it have (derived from what it IS)?
2. What test kinds DOES it have (from tests.jsonl)?
3. What's the gap?

This produces a per-unit `test_surface` record that downstream diagnose templates consume.

`{{PRIOR_FILE_1}}` = tests.jsonl
`{{PRIOR_FILE_2}}` = entry-points.jsonl
`{{PRIOR_FILE_3}}` = file-structure.jsonl

Optional fourth input: `frontend-components.jsonl` may exist in the same directory as the prior files. If present, also process it. Guard with `[ -f <path> ]` before reading.

---

## Step 1 — Guard: Verify Upstream Inputs

If `{{PRIOR_FILE_1}}` is missing or its `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"entry_type":"test_surface","status":"empty","reason":"tests inventory is empty — cannot compute test surface"}
```
Then append `Status: COMPLETE` and stop.

Apply the same guard to `{{PRIOR_FILE_2}}` and `{{PRIOR_FILE_3}}` — if either is missing or empty, continue with the inputs that are present but mark the missing source in the summary.

Check optional fourth input:
```bash
COMPONENTS_FILE="$(dirname {{PRIOR_FILE_1}})/frontend-components.jsonl"
[ -f "$COMPONENTS_FILE" ] && echo "components_present=true" || echo "components_present=false"
```

---

## Step 2 — Build Test Subject Index

From `{{PRIOR_FILE_1}}` (tests.jsonl), build an in-memory index: `tests_subject → array of kind values`.

- Skip `_summary` records and records where `is_test_file == false` (UNTESTED entries).
- Skip records where `tests_subject` is null.
- For each remaining record, append its `kind` value to the array keyed by `tests_subject`.

Example index:
```
"src/services/user-service.ts" → ["UNIT", "INTEGRATION"]
"src/routes/users.ts" → ["E2E"]
```

---

## Step 3 — Classify Expected Test Kinds

Expected test kinds by unit type:

| Unit Type | Detection | Expected Kinds |
|---|---|---|
| HTTP route / API endpoint | from entry-points.jsonl | `["INTEGRATION", "E2E"]` |
| Service file | `file_path` contains `/services/` | `["UNIT", "INTEGRATION"]` |
| Utility / helper | `file_path` contains `/utils/` or `/helpers/` | `["UNIT"]` |
| React component | `file_path` ends in `.tsx` AND filename starts with uppercase letter | `["COMPONENT"]` |
| Config / type / schema | filename matches `*.config.*`, `*.types.ts`, `*.schema.ts`, `types.ts`, `index.ts` (barrel) | `[]` (skip) |

`expected_min_count` = length of `expected_test_kinds`.

---

## Step 4 — Process Routes (entry-points.jsonl)

For each record in `{{PRIOR_FILE_2}}`:
- Skip `_summary` records.
- Set `unit_kind = "route"`, `expected_test_kinds = ["INTEGRATION", "E2E"]`, `expected_min_count = 2`.
- Look up `actual_kinds` in the index using the record's `file_path`. If not found, `actual_kinds = []`.
- `actual_test_files` = list of test file paths from tests.jsonl whose `tests_subject` matches this `file_path`.
- Count `matched = |actual_kinds ∩ expected_test_kinds|`.
- `gap_count = max(0, expected_min_count - matched)`.
- `fully_covered = (gap_count == 0)`.

Track route file paths in a set (for de-duplication in Step 5).

---

## Step 5 — Process Source Files (file-structure.jsonl)

For each record in `{{PRIOR_FILE_3}}`:
- Skip `_summary` records and records where `is_test == true`.
- Skip records already processed in Step 4 (file_path appears in the route set).
- Classify by path pattern (Step 3 table). If `expected_test_kinds` is empty, skip — emit no record.
- Build the JSONL record using the same fields and lookup logic as Step 4.

Set `unit_kind` to one of: `"service" | "utility" | "component" | "unknown"`.

Track all processed file paths in a "seen" set.

---

## Step 6 — Process Components (optional)

If `frontend-components.jsonl` exists:

```bash
COMPONENTS_FILE="$(dirname {{PRIOR_FILE_1}})/frontend-components.jsonl"
```

Read each record. Skip `_summary`. Skip records whose `file_path` is in the "seen" set (already covered by Step 5).

For each remaining component:
- `unit_kind = "component"`, `expected_test_kinds = ["COMPONENT"]`, `expected_min_count = 1`.
- Look up `actual_kinds`, compute `gap_count`, `fully_covered` as before.

---

## Step 7 — Write JSONL Records

Each record has these fields:
- `entry_type`: `"test_surface"`
- `unit_kind`: `"route" | "service" | "utility" | "component" | "unknown"`
- `name`: descriptive name (route name from entry-points.jsonl OR basename of file)
- `file_path`: relative to codebase root
- `expected_test_kinds`: array of kind strings
- `expected_min_count`: integer
- `actual_test_files`: array of test file paths covering this unit
- `actual_kinds`: array of test kind values that exist
- `gap_count`: integer (floored at 0)
- `fully_covered`: boolean

Example:
```json
{"entry_type":"test_surface","unit_kind":"service","name":"user-service.ts","file_path":"src/services/user-service.ts","expected_test_kinds":["UNIT","INTEGRATION"],"expected_min_count":2,"actual_test_files":["src/services/user-service.test.ts"],"actual_kinds":["UNIT"],"gap_count":1,"fully_covered":false}
```

---

## Step 8 — Write Summary

The final line of `{{OUTPUT_PATH}}` must be:

```json
{"_summary":true,"entry_type":"test_surface","status":"complete","total_units":N,"fully_covered":N,"partially_covered":N,"uncovered":N,"by_unit_kind":{"route":0,"service":0,"utility":0,"component":0},"total_gap_count":N}
```

Where:
- `partially_covered` = units with `0 < matched < expected_min_count`
- `uncovered` = units with `actual_kinds` empty

---

Status: COMPLETE
