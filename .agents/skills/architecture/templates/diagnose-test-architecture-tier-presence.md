# Diagnose — Test Architecture: Tier Presence

You are diagnosing test tier presence in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

A codebase needs all 4 test tiers to have real confidence:
- **Unit** — pure logic, no I/O
- **Integration** — real services / real DB
- **E2E** — real backend API end-to-end
- **UI/UX (COMPONENT)** — real frontend rendering

A missing tier is a structural gap, not a style issue. Without the tier, an entire class of regressions is invisible.

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = tests.jsonl

If the file is missing or its `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"tests inventory is empty — cannot evaluate tier presence"}
```
Then append `Status: COMPLETE` and stop.

Otherwise, read the `_summary` record and extract `by_kind` counts for `UNIT`, `INTEGRATION`, `E2E`, `COMPONENT`.

---

## Step 2 — Detect E2E / Component Runner Configs

```bash
find {{CODEBASE_PATH}} -maxdepth 3 \( -name "playwright.config.*" -o -name "cypress.config.*" \) 2>/dev/null | grep -v node_modules | head -5
```

```bash
find {{CODEBASE_PATH}} -maxdepth 3 \( -name "vitest.config.*" -o -name "jest.config.*" \) 2>/dev/null | grep -v node_modules | head -5
```

A runner config without tests means the tier is wired up but unused — a different signal than total absence.

---

## Step 3 — Evaluate Each Tier

For each tier (`UNIT`, `INTEGRATION`, `E2E`, `COMPONENT`):

- If `count == 0` AND no corresponding runner config found → **MAJOR** finding (tier entirely absent).
- If `count == 0` AND a runner config exists → **MINOR** finding (runner present, no tests written).
- If `count > 0` → no finding.

Relevant runner mapping:
- UNIT / COMPONENT / INTEGRATION → vitest.config.* or jest.config.*
- E2E → playwright.config.* or cypress.config.*

---

## Step 4 — Write Findings

For each missing tier, write a finding using this exact format:

```markdown
### Finding N — Missing test tier: <TIER>
- **severity:** MAJOR
- **principle:** A codebase needs all 4 test tiers (Unit, Integration, E2E, UI/UX) to have real confidence
- **location:** {{CODEBASE_PATH}}:1
- **description:** No <TIER> tests detected and no <TIER> runner is configured. An entire class of regressions is unverifiable.
- **evidence:** tests.jsonl by_kind.<TIER> == 0; `find` for runner configs returned 0 matches
- **remediation:**
  - **action:** Install and configure a <TIER>-tier runner, then add at least one passing test that exercises real behavior
  - **files:** [CREATE <runner>.config.ts | CREATE src/__tests__/<tier>/smoke.test.ts]
  - **acceptance:** `find . -name "<runner>.config.*"` returns a match AND test suite runs the new tier
  - **effort:** M
```

For the "runner exists but no tests" case, lower severity to MINOR and reword:
- description: "<TIER> runner is configured but no <TIER> tests exist."
- evidence: include the runner config path found.
- effort: S

---

## Step 5 — Write Summary

The final line of `{{OUTPUT_PATH}}` must be:

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"tiers_present":N,"tiers_missing":N,"missing_tier_names":["..."]}
```

---

Status: COMPLETE
