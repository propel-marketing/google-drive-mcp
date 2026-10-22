# Diagnose — Test Architecture: Infrastructure Completeness

You are diagnosing test infrastructure completeness in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Tests that don't run in CI don't exist. Coverage that isn't configured isn't measured. No fixture/factory files means every test hand-rolls its setup, leading to drift, copy-paste test data, and divergence between what tests assume and what production looks like.

Test infrastructure has three pillars:
1. **CI execution** — every PR runs the test suite
2. **Coverage measurement** — the suite reports what it does and doesn't cover
3. **Shared fixtures/factories** — test data lives in one canonical place

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = tests.jsonl

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"tests inventory is empty — cannot evaluate test infrastructure"}
```
Then append `Status: COMPLETE` and stop.

Read `_summary.total_test_files` for use in severity decisions.

---

## Step 2 — Check CI Test Wiring

```bash
find {{CODEBASE_PATH}} -maxdepth 3 \( -name "*.yml" -o -name "*.yaml" \) 2>/dev/null | grep -v node_modules | xargs grep -l "test\|vitest\|jest\|playwright" 2>/dev/null | head -5
```

Set `ci_runs_tests` = true if any CI file mentions a test command.

---

## Step 3 — Check Coverage Configuration

```bash
grep -n "coverage\|lcov\|c8\|istanbul" {{CODEBASE_PATH}}/package.json 2>/dev/null | head -5
```

```bash
grep -n "coverage" {{CODEBASE_PATH}}/vitest.config.* {{CODEBASE_PATH}}/jest.config.* 2>/dev/null | head -5
```

Set `coverage_configured` = true if any match.

---

## Step 4 — Check Fixtures / Factories

```bash
find {{CODEBASE_PATH}}/src \( -name "*.factory.ts" -o -name "*.fixture.ts" -o -name "*.seed.ts" \) 2>/dev/null | grep -v node_modules | head -10
```

```bash
find {{CODEBASE_PATH}}/src -type d \( -name "factories" -o -name "fixtures" -o -name "__fixtures__" \) 2>/dev/null | grep -v node_modules | head -5
```

Set `fixtures_present` = true if either returns a match.

---

## Step 5 — Evaluate and Write Findings

**Severity guide:**
- `ci_runs_tests == false` AND `total_test_files > 0` → **MAJOR** (tests exist but won't catch regressions in CI).
- `ci_runs_tests == false` AND `total_test_files == 0` → **MINOR** (no tests to run anyway, but CI hook missing).
- `coverage_configured == false` AND `total_test_files > 0` → **MINOR** (can't measure what's covered).
- `fixtures_present == false` AND `total_test_files > 10` → **NOTE** (likely hand-rolled setup duplication).

**CI not wired:**
```markdown
### Finding N — Test suite not executed in CI
- **severity:** MAJOR
- **principle:** Every test must run in CI — tests that don't run might as well not exist
- **location:** {{CODEBASE_PATH}}:1
- **description:** N test files exist but no CI config file references a test command. Regressions will not be caught at PR time.
- **evidence:** total_test_files=N, no .yml / .yaml mentions test/vitest/jest/playwright
- **remediation:**
  - **action:** Add a CI workflow step that runs the test suite on every PR
  - **files:** [CREATE .github/workflows/test.yml]
  - **acceptance:** `find . -name "*.yml" | xargs grep -l "test"` returns ≥ 1 match
  - **effort:** S
```

**Coverage missing:**
```markdown
### Finding N — Coverage measurement not configured
- **severity:** MINOR
- **principle:** Test coverage must be measured to be meaningful — what isn't measured drifts
- **location:** {{CODEBASE_PATH}}/package.json:1
- **description:** No coverage configuration found. The suite cannot report what is and isn't tested.
- **evidence:** No `coverage` / `lcov` / `c8` / `istanbul` reference in package.json or runner configs
- **remediation:**
  - **action:** Enable coverage reporting in the test runner config
  - **files:** [EDIT vitest.config.ts | EDIT package.json]
  - **acceptance:** `npm test -- --coverage` produces a coverage report
  - **effort:** XS
```

**Fixtures missing (only when total_test_files > 10):**
```markdown
### Finding N — No shared test fixtures or factories
- **severity:** NOTE
- **principle:** Test data should live in canonical fixtures/factories — hand-rolled setup duplicates and drifts
- **location:** {{CODEBASE_PATH}}/src:1
- **description:** N test files exist but no `*.factory.ts`, `*.fixture.ts`, or fixtures/factories directory was found. Test data is likely hand-rolled in each file.
- **evidence:** total_test_files=N, no fixture/factory files or directories found
- **remediation:**
  - **action:** Extract repeated setup into a `src/__fixtures__/` directory and adopt factory functions
  - **files:** [CREATE src/__fixtures__/<entity>.factory.ts]
  - **acceptance:** ≥ 1 factory file exists and is imported by ≥ 2 test files
  - **effort:** M
```

---

## Step 6 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"ci_runs_tests":true,"coverage_configured":false,"fixtures_present":false}
```

---

Status: COMPLETE
