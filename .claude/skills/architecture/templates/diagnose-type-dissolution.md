# Diagnose — Type Dissolution

You are quantifying type dissolution sites in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` and classifying each by severity.

This diagnostic runs **after** `diagnose-trace`. Read its output for the dissolution points already identified during data tracing, then expand the scan across the rest of the codebase.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read this file first. Confirm it ends with `Status: COMPLETE`.
If missing or incomplete: `Status: NEEDS_MORE_CONTEXT — diagnose/trace.md is missing or incomplete`

{{PRIOR_FILE_1}}

---

## What This Diagnostic Proves

Type dissolution is the moment a typed value loses its identity in the type system. The compiler stops being able to tell you what shape this data carries. Every dissolution is a downstream invitation for hallucinations — agents reading the file invent properties that may or may not exist; humans assume the shape that fits their intuition.

There are three mechanisms of dissolution, in increasing order of severity:

| Mechanism | Severity | Why |
|-----------|----------|-----|
| `as Type` after a runtime parse/validation | LOW | The cast is honest; the runtime check did the verification |
| `as Type` without runtime check (trust-me cast) | HIGH | The compiler is told to trust unverified data |
| `: any` / `: unknown` / `: object` / `: {}` | CRITICAL | The type system is told this could be anything |
| Anonymous destructuring of typed data | MEDIUM | The destructured names lose their parent type |

This diagnostic catalogs every dissolution and classifies it.

---

## Step 1 — Read Trace Output

The trace diagnostic identified dissolution points along the journey of 3 core structures. Extract those into a working list.

For each dissolution from trace:
- File:line
- Mechanism (cast / any / destructure)
- What was lost (the typed structure that dissolved)
- Downstream impact (which files consume the dissolved value)

This is your starting set.

---

## Step 2 — Expand the Scan: `any` Usages

```bash
grep -rn ": any\b\|<any>\|as any\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "// eslint-disable"
```

For each occurrence:
- Read the surrounding 5 lines
- Classify the boundary context: at an external boundary (HTTP/queue/DB before parse) → ACCEPTABLE; in trusted code (after parse, in services) → CRITICAL violation

---

## Step 3 — Expand the Scan: `unknown` and `object` Usages

```bash
grep -rn ": unknown\b\|<unknown>" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn ": object\b\|: Object\b\|: {}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

`unknown` is honest (forces narrowing before use) — flag only if it propagates without narrowing. `object` and `{}` are nearly always violations (they accept any object shape).

---

## Step 4 — Expand the Scan: Type Assertions

All `as T` casts (not just `as any`):

```bash
grep -rn " as [A-Z][A-Za-z]*\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "// eslint-disable"
```

For each `as Type`:
- Read the prior 3 lines. Did a `parse()`, `safeParse()`, or schema validation happen? → BOUNDARY_CAST (acceptable)
- No prior validation? → TRUST_ME_CAST (violation)

`as const` is not a dissolution — it's the opposite (narrowing). Skip.
`as unknown as T` (double cast) is always a violation — flag separately as DOUBLE_CAST.

---

## Step 5 — Expand the Scan: Anonymous Destructuring of Typed Data

This is harder to grep for mechanically. Focus on destructured function parameters and inline destructure of API response data:

```bash
grep -rn "function.*({.*}: any\|function.*({.*}: unknown\|=> {.*}: any" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Also scan files for the pattern `const { a, b } = response.data` where `response.data` has type `any`:

```bash
grep -rn "const { .* } = .*\.data\|const { .* } = .*\.body\|const { .* } = await " {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each candidate, read the surrounding code and confirm whether the source value was typed (no dissolution) or `any`/`unknown` (dissolution at the destructure site).

---

## Step 6 — Tally by Severity

Classify every dissolution found across Steps 1–5:

| Severity | Mechanism | Where |
|----------|-----------|-------|
| CRITICAL | `: any` in trusted code | service / business logic layers |
| CRITICAL | `as unknown as T` (double cast) | anywhere |
| HIGH | `as T` without prior validation | anywhere except boundary |
| HIGH | anonymous destructure of `any` source | anywhere |
| MEDIUM | `: object` / `: {}` | anywhere |
| LOW | `as T` after parse/validation | boundary (acceptable but note) |
| LOW | `: any` at boundary before parse | acceptable but note |
| INFO | `: unknown` properly narrowed before use | acceptable |

---

## Step 7 — Write Findings

Write one JSONL line per dissolution site to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "type_safety"
- `diagnostic_type`: "type_dissolution"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Severity mapping from diagnostic:
- CRITICAL → "CRITICAL" (`: any` in trusted code, double casts)
- HIGH → "MAJOR" (trust-me casts without prior validation)
- MEDIUM → "MINOR" (`: object`, `: {}`)
- LOW/INFO → "INFO" (boundary casts, acceptable `unknown`)

Example:
{"category":"type_safety","diagnostic_type":"type_dissolution","severity":"CRITICAL","file_path":"src/services/billing.ts","line_number":67,"description":"DISSOLUTION: StripeCharge response typed as ': any' in service layer — downstream calculatePrice() reads .amount without compiler guarantee","recommended_action":"Use Stripe SDK's typed response or add schema parse at this point","finding_signature":"8899aabbccddeeff","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"type_dissolution","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"overall_verdict":"PASS|PARTIAL|FAIL","status":"complete"}

---

## Step 8 — Highest-Priority Issues

```
1. [file:line] — CRITICAL — `: any` in trusted code — type from upstream parse or add validation
2. [file:line] — CRITICAL — double cast — replace with proper schema parse
3. [file:line] — HIGH — trust-me cast — add schema parse before cast
4. [file] — concentration — N dissolution sites in one file — consider rewrite
```

---

Append as final line:
`Status: COMPLETE`
