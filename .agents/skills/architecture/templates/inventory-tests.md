# Inventory — Tests

You are cataloging the test suite structure of the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

This inventory maps the test surface: how many tests exist, what they test, and whether the test patterns support confident refactoring. It answers: are there tests, what layer do they cover, and what are the gaps?

---

## Step 1 — Find All Test Files

```bash
find {{CODEBASE_PATH}}/src -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" | grep -v node_modules | grep -v ".next" | head -60
```

```bash
find {{CODEBASE_PATH}} -name "*.test.ts" -o -name "*.spec.ts" | grep -v node_modules | grep -v ".next" | grep -v src | head -20
```

Count test files by layer (services, routes/api, components, utils):
```bash
find {{CODEBASE_PATH}}/src -name "*.test.ts" -o -name "*.spec.ts" | grep -v node_modules | sed 's|.*/src/||' | cut -d'/' -f1 | sort | uniq -c | sort -rn
```

---

## Step 2 — Count Test Cases

```bash
grep -rn "it(\|test(\|describe(" {{CODEBASE_PATH}}/src --include="*.test.ts" --include="*.spec.ts" --include="*.test.tsx" --include="*.spec.tsx" | grep -v node_modules | wc -l
```

```bash
grep -rn "it\.skip\|test\.skip\|xit(\|xtest(" {{CODEBASE_PATH}}/src --include="*.test.ts" --include="*.spec.ts" | grep -v node_modules | head -20
```

---

## Step 3 — Identify Test Patterns

```bash
grep -rn "vi\.mock\|jest\.mock\|mock\.\|sinon\." {{CODEBASE_PATH}}/src --include="*.test.ts" --include="*.spec.ts" | grep -v node_modules | wc -l
```

```bash
grep -rn "supertest\|request(\|fetch(" {{CODEBASE_PATH}}/src --include="*.test.ts" --include="*.spec.ts" | grep -v node_modules | head -15
```

```bash
grep -rn "renderHook\|render(\|screen\." {{CODEBASE_PATH}}/src --include="*.test.ts" --include="*.spec.tsx" | grep -v node_modules | head -15
```

Classify each test file as: UNIT (mocks dependencies), INTEGRATION (hits real DB or service), E2E (browser/full-stack), COMPONENT (render tests).

---

## Step 4 — Find Untested Service Files

```bash
find {{CODEBASE_PATH}}/src/services -name "*.ts" | grep -v node_modules | grep -v ".test." | grep -v ".spec." | while read f; do base=$(basename "$f" .ts); if ! find {{CODEBASE_PATH}}/src -name "${base}.test.ts" -o -name "${base}.spec.ts" | grep -q .; then echo "UNTESTED: $f"; fi; done | head -20
```

---

## Step 5 — Write the Inventory

Write one JSONL line per test file to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "tests"
- `kind`: "UNIT" | "INTEGRATION" | "E2E" | "COMPONENT" | "UNKNOWN"
- `name`: test file name (string)
- `file_path`: path relative to codebase root
- `line_number`: 1
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: true
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `test_count`: integer (number of `it(` / `test(` calls)
- `skip_count`: integer (number of `it.skip` / `test.skip`)
- `uses_mocks`: boolean
- `tests_subject`: string (relative path to the file being tested, or null)

After all test file entries, emit one JSONL line per untested service file:
- `entry_type`: "tests"
- `kind`: "UNTESTED"
- `name`: source file name
- `file_path`: path relative to codebase root
- `line_number`: 1
- `layer`: "backend"
- `is_exported`: false
- `is_test_file`: false
- `confidence`: "ai_judged"
- `test_count`: 0
- `skip_count`: 0
- `uses_mocks`: false
- `tests_subject`: null

Example:
{"entry_type":"tests","kind":"UNIT","name":"user-service.test.ts","file_path":"src/services/user-service.test.ts","line_number":1,"layer":"backend","is_exported":false,"is_test_file":true,"confidence":"parsed","test_count":12,"skip_count":1,"uses_mocks":true,"tests_subject":"src/services/user-service.ts"}

After all entries:
{"_summary":true,"entry_type":"tests","total_test_files":N,"total_test_cases":N,"skipped_count":N,"by_kind":{"UNIT":0,"INTEGRATION":0,"E2E":0,"COMPONENT":0,"UNKNOWN":0},"untested_service_files":N,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
