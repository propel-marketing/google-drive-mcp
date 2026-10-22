# Diagnose — Test Architecture: Coverage vs Journeys

You are diagnosing route/journey coverage in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Every API route and page entry-point must have:
1. At least one **integration test** — verifies the route chain (handler → service → DB) with real services.
2. At least one **E2E test** — verifies the full request/response cycle over HTTP.

A route with zero coverage is an untested contract — there is no automated guarantee that the endpoint exists, returns the right shape, or doesn't crash on common inputs. A route with only one of the two has a known blind spot.

---

## Step 1 — Load Upstream Inventory

`{{PRIOR_FILE_1}}` = test-surface.jsonl

If the file is missing or `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"test-surface inventory is empty — cannot evaluate journey coverage"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Collect Routes

From `{{PRIOR_FILE_1}}`, collect records where `unit_kind == "route"`. Skip `_summary`.

For each route, evaluate `actual_kinds`:
- `actual_kinds` is empty → **uncovered**
- `actual_kinds` contains both `"INTEGRATION"` and `"E2E"` → **fully_covered**
- otherwise → **partially_covered**

---

## Step 3 — Group Findings

Do NOT emit one finding per route. Group by severity:

- All **uncovered** routes → one MAJOR finding listing the routes as evidence.
- All **partially_covered** routes → one MINOR finding listing the routes and the missing kind per route.

If a group is empty, skip its finding.

---

## Step 4 — Write Findings

**Uncovered routes (MAJOR, single grouped finding):**
```markdown
### Finding N — Routes with zero test coverage
- **severity:** MAJOR
- **principle:** Every route must have at least one integration test and one E2E test
- **location:** <first uncovered route file_path>:1
- **description:** N route(s) have no integration or E2E coverage. The endpoint contract is unverified — there is no automated proof that the route returns the documented shape or handles common inputs.
- **evidence:** Uncovered routes (from test-surface.jsonl, unit_kind=route, actual_kinds=[]):
    - <route 1 name> — <file_path>
    - <route 2 name> — <file_path>
    - ... (cap at 20, then "+N more")
- **remediation:**
  - **action:** Add at least one integration test and one E2E test per route, starting with the highest-traffic endpoints
  - **files:** [CREATE <route_file>.integration.test.ts | CREATE e2e/<route_name>.spec.ts]
  - **acceptance:** Every route in test-surface.jsonl has actual_kinds ⊇ {INTEGRATION, E2E}
  - **effort:** L
```

**Partially covered routes (MINOR, single grouped finding):**
```markdown
### Finding N — Routes with partial test coverage
- **severity:** MINOR
- **principle:** Every route needs both integration and E2E coverage — having only one leaves a known blind spot
- **location:** <first partial route file_path>:1
- **description:** N route(s) have only one of the two required test kinds. The missing kind for each is listed below.
- **evidence:** Partially covered routes (route — missing kind):
    - <route 1 name> (<file_path>) — missing E2E
    - <route 2 name> (<file_path>) — missing INTEGRATION
    - ... (cap at 20)
- **remediation:**
  - **action:** Add the missing test kind for each listed route
  - **files:** [<list of test files to create>]
  - **acceptance:** Every route's actual_kinds ⊇ {INTEGRATION, E2E}
  - **effort:** M
```

---

## Step 5 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"routes_total":N,"fully_covered":N,"partially_covered":N,"uncovered":N}
```

---

Status: COMPLETE
