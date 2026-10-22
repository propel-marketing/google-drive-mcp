# Diagnose — Test Architecture: Runner Coherence

You are diagnosing test runner coherence in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

One test runner per tier. Jest and Vitest in the same project creates configuration drift, different assertion APIs, and CI inconsistency. Two E2E frameworks (Playwright + Cypress) means double-maintenance of the same coverage with no added confidence.

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = tests.jsonl

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"tests inventory is empty — cannot evaluate runner coherence"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Find Runner Config Files

```bash
find {{CODEBASE_PATH}} -maxdepth 3 \( -name "jest.config.*" -o -name "vitest.config.*" -o -name "playwright.config.*" -o -name "cypress.config.*" \) 2>/dev/null | grep -v node_modules | head -10
```

Record which configs were found.

---

## Step 3 — Check package.json Runner Dependencies

```bash
grep -E '"jest"|"vitest"|"@jest/|"@vitest/|"playwright"|"@playwright/|"cypress"' {{CODEBASE_PATH}}/package.json 2>/dev/null | head -10
```

Combine config detection and dep detection — either signal counts a runner as "present".

---

## Step 4 — Evaluate

Build `runners_detected`: array of strings drawn from `["jest", "vitest", "playwright", "cypress"]`.

- `"jest" ∈ detected` AND `"vitest" ∈ detected` → **MAJOR** finding (mixed unit runners).
- `"playwright" ∈ detected` AND `"cypress" ∈ detected` → **MINOR** finding (mixed E2E runners).
- `runners_detected` is empty AND tests.jsonl `_summary.total_test_files > 0` → **MAJOR** finding (tests exist but no runner config — orphaned tests).
- `runners_detected` is empty AND `total_test_files == 0` → **NOTE** finding (no test infrastructure at all).

Set `mixing_detected = true` if either of the first two conditions hits.

---

## Step 5 — Write Findings

**Jest + Vitest collision:**
```markdown
### Finding N — Mixed unit-test runners: Jest and Vitest
- **severity:** MAJOR
- **principle:** One unit-test runner per project — mixing Jest and Vitest causes config drift and CI inconsistency
- **location:** {{CODEBASE_PATH}}/package.json:1
- **description:** Both Jest and Vitest are configured. Tests run under two different runners with subtly different APIs (mocking, timers, ESM handling).
- **evidence:** Found jest.config.* AND vitest.config.* (or both in package.json deps)
- **remediation:**
  - **action:** Pick one runner (Vitest recommended for new projects), migrate all tests to it, remove the other's config and deps
  - **files:** [DELETE <loser>.config.* | EDIT package.json | <update all test files>]
  - **acceptance:** Only one of jest.config / vitest.config exists; `grep -E '"jest"|"vitest"' package.json` returns one match family
  - **effort:** L
```

**Playwright + Cypress collision:**
```markdown
### Finding N — Mixed E2E runners: Playwright and Cypress
- **severity:** MINOR
- **principle:** One E2E runner per project — running both doubles maintenance with no added confidence
- **location:** {{CODEBASE_PATH}}/package.json:1
- **description:** Both Playwright and Cypress are configured. The same user journeys risk being tested twice in incompatible ways.
- **evidence:** Found playwright.config.* AND cypress.config.*
- **remediation:**
  - **action:** Consolidate on one E2E runner, migrate any unique coverage, remove the other
  - **files:** [DELETE <loser>.config.* | EDIT package.json]
  - **acceptance:** Only one E2E runner config exists
  - **effort:** L
```

**No runner with tests present:**
```markdown
### Finding N — Tests exist with no detectable runner configuration
- **severity:** MAJOR
- **principle:** Every test file must be executable by a configured runner — orphaned tests give a false sense of coverage
- **location:** {{CODEBASE_PATH}}:1
- **description:** N test files exist but no jest/vitest/playwright/cypress config or dependency was detected.
- **evidence:** total_test_files=N, runners_detected=[]
- **remediation:**
  - **action:** Install and configure a runner (Vitest recommended), wire it into `npm test`
  - **files:** [CREATE vitest.config.ts | EDIT package.json]
  - **acceptance:** `npm test` discovers and runs all *.test.ts files
  - **effort:** M
```

**No infrastructure at all:**
```markdown
### Finding N — No test runner configured
- **severity:** NOTE
- **principle:** Even greenfield projects benefit from a runner being installed before the first test is written
- **location:** {{CODEBASE_PATH}}:1
- **description:** No test runner config or test files were found. Test infrastructure is absent.
- **evidence:** runners_detected=[], total_test_files=0
- **remediation:**
  - **action:** Install Vitest and add a smoke test
  - **files:** [CREATE vitest.config.ts | CREATE src/__tests__/smoke.test.ts | EDIT package.json]
  - **acceptance:** `npm test` runs at least one passing test
  - **effort:** S
```

---

## Step 6 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"runners_detected":["..."],"mixing_detected":true}
```

---

Status: COMPLETE
