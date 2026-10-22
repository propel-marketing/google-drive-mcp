# Diagnose — Test Architecture: Mock Usage

You are diagnosing mock usage in tests in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Mocks test the mock, not the system. Every `jest.mock` / `vi.mock` is a signal that the test is not verifying real behavior — it's verifying a hand-coded stand-in. Unit tests should test real logic with no external deps; integration tests should hit real services and a real DB. Mock usage is a gap indicator — the mock should be replaced with either a real dependency (integration tier) or a deterministic fixture.

The goal is not zero mocks at all costs; it's surfacing every mock so the team can decide whether each one is justified.

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = tests.jsonl

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"tests inventory is empty — cannot evaluate mock usage"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Filter Tests with Mocks

Read each non-summary record. Collect records where `uses_mocks == true`.

Count totals:
- `total_test_files` = count of records with `is_test_file == true`
- `files_with_mocks` = count of records with `uses_mocks == true`
- `mock_free_files` = `total_test_files - files_with_mocks`

---

## Step 3 — For Each Mocking File, Identify the Mock Targets

For each file with `uses_mocks == true`:

```bash
grep -n "jest\.mock\|vi\.mock\|jest\.spyOn\|vi\.spyOn" {{CODEBASE_PATH}}/<file_path> 2>/dev/null | head -10
```

Classify each mock target:
- Path contains `/services/`, `/db/`, `/repositories/`, `/clients/`, `prisma`, `drizzle`, `mongoose` → **DB/service mock** → MAJOR (should be an integration test).
- Path is a relative app module → **internal module mock** → MAJOR (likely hiding real behavior).
- Path is a npm package (no `./` or `../` prefix) and is a utility/codec/parser → **external utility mock** → MINOR.
- Otherwise → **MINOR**.

Severity of the file's finding = highest severity among its mock targets.

---

## Step 4 — Write Findings (one per test file with mocks)

```markdown
### Finding N — Mocked dependencies in <test file>
- **severity:** MAJOR | MINOR
- **principle:** Tests should verify real behavior — mocks test the mock, not the system
- **location:** <file_path>:<first mock line>
- **description:** This test mocks <N> module(s): <list of targets>. The test verifies behavior against a hand-coded stand-in rather than the real dependency.
- **evidence:** `grep -n "jest\.mock\|vi\.mock" <file_path>` returned: <paste lines>
- **remediation:**
  - **action:** Replace DB/service mocks by promoting the test to the integration tier with a real test DB; replace utility mocks with deterministic fixtures
  - **files:** [EDIT <file_path>]
  - **acceptance:** `grep -c "jest\.mock\|vi\.mock\|jest\.spyOn\|vi\.spyOn" <file_path>` returns 0
  - **effort:** S | M
```

If `files_with_mocks` is large (> 20), group MINOR utility-mock findings into a single batched finding listing the affected files as evidence, and emit individual findings only for MAJOR cases.

---

## Step 5 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"total_test_files":N,"files_with_mocks":N,"mock_free_files":N}
```

---

Status: COMPLETE
