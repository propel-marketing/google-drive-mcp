# Diagnose — Frontend Render Boundary Correctness

You are diagnosing render boundary violations in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Read the upstream render boundaries inventory from: `{{PRIOR_FILE_1}}`
Read the upstream components inventory from: `{{PRIOR_FILE_2}}`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Server/client boundaries must be correct: data-fetching components need a Suspense boundary above them; client components must not import server-only modules; Suspense boundaries must have a fallback prop.

---

## Step 1 — Load Upstream Inventories

Read `{{PRIOR_FILE_1}}` (frontend render boundaries) and `{{PRIOR_FILE_2}}` (frontend components). Parse each JSONL record, skipping `_summary` lines.

If either file is missing or has `_summary.status` of `"empty"`, write:
```json
{"_summary":true,"status":"empty","reason":"Required upstream inventory is empty — render boundary correctness not applicable"}
```
Then append `Status: COMPLETE` and stop.

---

## Step 2 — Check Suspense Boundaries Have Fallback

From the render boundaries inventory, find every record where `kind == "suspense"` and `has_fallback == false`:

```bash
grep -n '<Suspense' {{CODEBASE_PATH}}/{{FILE_PATH}} | grep -v 'fallback'
```

Each `<Suspense>` without a `fallback` prop shows a blank screen on load. Flag as MAJOR.

---

## Step 3 — Check Data-Fetching Components Have Suspense Above Them

For each component in the components inventory that uses `useQuery`, `useSWR`, or async data fetching, verify a `<Suspense>` boundary exists somewhere in its render tree:

```bash
grep -rn 'useQuery\|useSWR\|useInfiniteQuery' {{CODEBASE_PATH}}/{{FILE_PATH}} | head -5
```

Then check whether the component is wrapped in Suspense at its call sites:
```bash
grep -rn "{{COMPONENT_NAME}}" {{CODEBASE_PATH}}/src --include='*.tsx' | grep -v 'import\|export' | head -10
```

---

## Step 4 — Check Client Components Don't Import Server-Only

For each `"use client"` file, check for server-only imports:

```bash
grep -n "from 'server-only'\|from \"server-only\"\|import.*server" {{CODEBASE_PATH}}/{{FILE_PATH}} | head -5
```

Also check for direct database/ORM imports in client files (Prisma, Drizzle, etc.):
```bash
grep -n "from '@prisma\|from 'drizzle\|from 'mongoose\|from 'pg'" {{CODEBASE_PATH}}/{{FILE_PATH}} | head -5
```

A client component importing server-only or database modules is a CRITICAL violation — it exposes server secrets to the browser bundle.

---

## Step 5 — Write Findings

For each violation, write a markdown finding block to `{{OUTPUT_PATH}}`:

```markdown
### Finding N — <short imperative title>
- **severity:** CRITICAL | MAJOR | MINOR
- **principle:** <which boundary rule was violated>
- **location:** path/to/file.tsx:LINE
- **description:** <what's wrong>
- **evidence:** <grep output or line content>
- **remediation:**
  - **action:** <what to do>
  - **files:** [EDIT path:line]
  - **acceptance:** <grep / tsc --noEmit verifiable condition>
  - **effort:** XS | S | M
```

---

## Step 6 — Write Summary

The last line of `{{OUTPUT_PATH}}` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"boundaries_evaluated":N,"suspense_missing_fallback":N,"missing_suspense_wrapper":N,"server_import_in_client":N}
```

---

Status: COMPLETE
