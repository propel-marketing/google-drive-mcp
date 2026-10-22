# Diagnose — Test Architecture: Folder Mirror

You are diagnosing test file placement in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream inventory from: `{{PRIOR_FILE_1}}`
Read the upstream inventory from: `{{PRIOR_FILE_2}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Test files must be findable. Either:
- **Co-located** — tests live next to the source (`foo.ts` + `foo.test.ts`), OR
- **Parallel** — tests live in `__tests__/` directories that mirror the source tree

Mixing both patterns scatters tests across the repo, making the suite unmaintainable and onboarding painful. The codebase should pick one and follow it.

---

## Step 1 — Load Upstream Inventories

`{{PRIOR_FILE_1}}` = tests.jsonl
`{{PRIOR_FILE_2}}` = file-structure.jsonl

If `{{PRIOR_FILE_1}}` is missing or its `_summary.status` is `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"tests inventory is empty — cannot evaluate folder mirror"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Detect Dominant Pattern

Count test placements:

```bash
find {{CODEBASE_PATH}}/src \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \) 2>/dev/null | grep -v node_modules | grep "__tests__" | wc -l
```

```bash
find {{CODEBASE_PATH}}/src \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \) 2>/dev/null | grep -v node_modules | grep -v "__tests__" | wc -l
```

Determine `dominant_pattern`:
- `colocated_count > 2 * parallel_count` → `"colocated"`
- `parallel_count > 2 * colocated_count` → `"parallel_dir"`
- otherwise → `"mixed"`

---

## Step 3 — Find Orphans (tests not following dominant pattern)

If dominant is `"colocated"`:
```bash
find {{CODEBASE_PATH}}/src \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \) 2>/dev/null | grep -v node_modules | grep "__tests__" | head -40
```

If dominant is `"parallel_dir"`:
```bash
find {{CODEBASE_PATH}}/src \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \) 2>/dev/null | grep -v node_modules | grep -v "__tests__" | head -40
```

If dominant is `"mixed"`, both lists are violations (no canonical pattern exists).

---

## Step 4 — Find Unmapped Source Directories

For each top-level directory under `src/`, check whether it contains any test file (co-located or in a sibling `__tests__/`):

```bash
for dir in $(find {{CODEBASE_PATH}}/src -maxdepth 2 -type d 2>/dev/null | grep -v node_modules | grep -v __tests__); do
  count=$(find "$dir" -maxdepth 2 \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \) 2>/dev/null | wc -l)
  source_count=$(find "$dir" -maxdepth 2 \( -name "*.ts" -o -name "*.tsx" \) 2>/dev/null | grep -v ".test." | grep -v ".spec." | wc -l)
  if [ "$source_count" -gt 0 ] && [ "$count" -eq 0 ]; then echo "UNMAPPED: $dir ($source_count source files, 0 tests)"; fi
done | head -20
```

---

## Step 5 — Write Findings (Grouped, Not Per-File)

Emit **one finding per pattern cluster**, not one per file.

**Finding for mixed pattern** (only if `dominant_pattern == "mixed"`):
```markdown
### Finding N — No canonical test placement convention
- **severity:** MAJOR
- **principle:** Test files must follow a single placement convention (co-located OR parallel __tests__)
- **location:** {{CODEBASE_PATH}}/src:1
- **description:** Tests are split nearly evenly between co-located (N files) and `__tests__/` directories (N files). New contributors cannot predict where to put a new test.
- **evidence:** colocated_count=N, parallel_count=N
- **remediation:**
  - **action:** Pick one pattern, document it in CONTRIBUTING.md, migrate the minority bucket
  - **files:** [EDIT CONTRIBUTING.md | <move test files to canonical location>]
  - **acceptance:** Either colocated_count or parallel_count == 0
  - **effort:** M
```

**Finding for orphans** (if dominant is colocated or parallel_dir and orphan list non-empty):
```markdown
### Finding N — Test files violating dominant placement pattern
- **severity:** MINOR
- **principle:** Tests should follow the codebase's dominant placement convention
- **location:** <first orphan>:1
- **description:** N test files do not follow the dominant `<dominant_pattern>` convention. List: <first 5 paths>, ...
- **evidence:** dominant=<pattern>, orphans=N
- **remediation:**
  - **action:** Move orphan tests to the canonical location
  - **files:** [<list of paths to move>]
  - **acceptance:** All test files match the dominant pattern grep
  - **effort:** S
```

**Finding for unmapped source directories** (if any):
```markdown
### Finding N — Source directories with zero test coverage
- **severity:** MAJOR
- **principle:** Every source directory containing logic should have at least one test file
- **location:** <first unmapped dir>:1
- **description:** N source directories contain code but no test files. Untested modules: <first 5>, ...
- **evidence:** unmapped_source_dirs=N
- **remediation:**
  - **action:** Add at least one test per unmapped directory, starting with the highest-traffic services
  - **files:** [<list of unmapped dirs>]
  - **acceptance:** Every directory under src/ with > 0 source files has ≥ 1 test file
  - **effort:** L
```

---

## Step 6 — Write Summary

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"dominant_pattern":"colocated|parallel_dir|mixed","colocated_count":N,"parallel_count":N,"orphan_count":N,"unmapped_source_dirs":N}
```

---

Status: COMPLETE
