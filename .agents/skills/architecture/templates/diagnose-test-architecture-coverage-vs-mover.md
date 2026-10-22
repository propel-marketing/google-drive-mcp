# Diagnose — Test Architecture: Coverage vs Services

You are diagnosing service-level test coverage in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Service files contain core business logic — the highest-leverage test target in the codebase. A service without **unit tests** has no regression protection for its logic. A service without **integration tests** has no verification that it interacts correctly with its dependencies (DB, external APIs, other services). Both are required to call the service "tested".

Routes are thin wrappers; services are where the value lives. Untested services are the highest-impact gap a codebase can have.

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = test-surface.jsonl

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"test-surface inventory is empty — cannot evaluate service coverage"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Collect Services

From `{{PRIOR_FILE_1}}`, collect records where `unit_kind == "service"`. Skip `_summary`.

For each service, classify based on `actual_kinds`:
- empty → **uncovered**
- contains `"UNIT"` only (no `"INTEGRATION"`) → **unit_only**
- contains `"INTEGRATION"` only (no `"UNIT"`) → **integration_only**
- contains both → **fully_covered**

---

## Step 3 — Group Findings by Severity

Do NOT emit one finding per service. Emit at most three grouped findings:

- All **uncovered** services → one MAJOR finding.
- All **unit_only** services → one MINOR finding.
- All **integration_only** services → one MINOR finding.

Skip any group that is empty.

---

## Step 4 — Write Findings

**Uncovered services (MAJOR, grouped):**
```markdown
### Finding N — Services with zero test coverage
- **severity:** MAJOR
- **principle:** Every service must have both unit and integration tests — services are the highest-leverage test target
- **location:** <first uncovered service file_path>:1
- **description:** N service(s) have neither unit nor integration coverage. Core business logic has no automated regression protection.
- **evidence:** Uncovered services (from test-surface.jsonl, unit_kind=service, actual_kinds=[]):
    - <service 1 file_path>
    - <service 2 file_path>
    - ... (cap at 20, then "+N more")
- **remediation:**
  - **action:** Add unit tests for pure logic and integration tests for dependency interactions, starting with services with the most importers
  - **files:** [CREATE <service>.test.ts | CREATE <service>.integration.test.ts]
  - **acceptance:** Every service in test-surface.jsonl has actual_kinds ⊇ {UNIT, INTEGRATION}
  - **effort:** L
```

**Unit-only services (MINOR, grouped):**
```markdown
### Finding N — Services with unit tests but no integration tests
- **severity:** MINOR
- **principle:** Unit tests prove logic; integration tests prove the service works with its real dependencies — both are needed
- **location:** <first unit-only service file_path>:1
- **description:** N service(s) have unit tests but no integration tests. The interaction with DB / external services is unverified.
- **evidence:** Unit-only services:
    - <service 1 file_path>
    - <service 2 file_path>
    - ... (cap at 20)
- **remediation:**
  - **action:** Add an integration test per listed service that exercises real dependencies (test DB, real HTTP clients)
  - **files:** [CREATE <service>.integration.test.ts]
  - **acceptance:** Every listed service has INTEGRATION in actual_kinds
  - **effort:** M
```

**Integration-only services (MINOR, grouped):**
```markdown
### Finding N — Services with integration tests but no unit tests
- **severity:** MINOR
- **principle:** Integration tests are slow and cover interaction — unit tests cover branches and edge cases cheaply
- **location:** <first integration-only service file_path>:1
- **description:** N service(s) have integration tests but no unit tests. Branch coverage and edge-case logic is likely under-tested.
- **evidence:** Integration-only services:
    - <service 1 file_path>
    - <service 2 file_path>
    - ... (cap at 20)
- **remediation:**
  - **action:** Add focused unit tests for pure logic and edge cases per service
  - **files:** [CREATE <service>.test.ts]
  - **acceptance:** Every listed service has UNIT in actual_kinds
  - **effort:** M
```

---

## Step 5 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"services_total":N,"fully_covered":N,"unit_only":N,"integration_only":N,"uncovered":N}
```

---

Status: COMPLETE
