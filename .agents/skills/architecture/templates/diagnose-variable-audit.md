# Diagnose — Variable Audit

You are auditing whether variable names in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` encode domain role and trust level, not technical type.

Read this inventory file:
- `{{INV_DIR}}/file-structure.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory file listed above. It must end with `Status: COMPLETE`.
If the inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/file-structure.jsonl`

---

## What This Diagnostic Proves

Variable names are inline documentation that cannot go stale because they're part of the code. A name like `rawApiPayload` tells the reader: this is data, it came from an external API, it has not been validated. A name like `data` tells the reader nothing.

Three rules:
- Names encode **domain role** (`estimate`, `paymentRecord`, `crewSchedule`) — not technical type (`obj`, `data`, `result`)
- Names encode **trust level** at boundaries (`raw`, `parsed`, `validated`, `persisted`) — so the reader can tell at a glance whether the value can be trusted
- Names are **specific** — `paymentResponse` is better than `response`; `userIdToken` is better than `tokenString`

The diagnostic checks whether the codebase actually applies these rules, not whether someone wrote them down.

---

## Step 1 — Sample Three Random Source Files

```bash
find {{CODEBASE_PATH}}/src -type f \( -name "*.ts" -o -name "*.tsx" \) | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | shuf -n 3
```

These three files are the audit sample. Read each one fully.

Skip pure aggregation files (barrels, schema files, registries) — they don't contain meaningful local variable naming. If the random sample lands on aggregation files, re-shuffle.

---

## Step 2 — Catalog Every Local Variable Declaration

For each sampled file, extract every `const`, `let`, and function parameter. Capture:
- The variable name
- The type (if annotated) or inferred type
- Where it's declared (line number)
- What it holds (one phrase)

```bash
grep -n "^[[:space:]]*const \|^[[:space:]]*let \|function.*(" {{SAMPLED_FILE}}
```

Read the surrounding lines to understand the variable's role.

---

## Step 3 — Score Each Variable

For each variable, apply these tests:

### Domain role test
Does the name reference a domain concept (from glossary or inventory vocabulary)?
- PASS: `estimate`, `crewMember`, `paymentRecord`, `inspectionReport`
- FAIL: `data`, `obj`, `tmp`, `result`, `value`, `item`, `record` (when not specifically a record-of-known-domain), `response` (when not specifying which response)

### Trust-level test (for variables crossing boundaries)
For variables holding data that came from outside the system (request body, DB query result, third-party API response), does the name encode trust level?
- PASS: `rawApiPayload`, `validatedInput`, `persistedOrder`, `parsedConfig`
- FAIL: `payload`, `input`, `order`, `config` — without trust qualifier when the trust level matters

### Specificity test
Does the name disambiguate from other similar variables in scope?
- PASS: `userIdToken` distinguishes from `accessToken` and `refreshToken`
- FAIL: `token` when multiple token kinds are in play

### Type-vs-role test (the most common violation)
Does the name describe what the variable *is* (its domain role) or what it *was made of* (its technical type)?
- PASS: `customerProfile` (role)
- FAIL: `string1`, `arr`, `obj`, `dict`, `map` (type) — except when the domain role genuinely is "an array" with no further meaning, which is rare

---

## Step 4 — Tally Per File

For each sampled file:

```
File: src/services/example.ts

Variables audited: N
  PASS (all four tests): N
  FAIL — generic name: N
  FAIL — missing trust level at boundary: N
  FAIL — type-not-role: N

Notable violations:
- Line 23: `const data = await db.select(...)` — should be `const userRecord = ...`
- Line 47: `function process(input: User)` — `input` is generic; should be `userToProcess` or specific to action
- Line 89: `const result = transform(data)` — both names are generic
```

---

## Step 5 — Identify the Worst Offender Categories

Across the three sampled files, count violations by category:

| Category | Count | Most Common Offending Names |
|----------|-------|---------------------------|
| Generic names (data, result, value) | N | data (12), result (8), value (4) |
| Type-not-role (obj, arr, str) | N | obj (5), arr (3) |
| Missing trust level at boundary | N | (specific lines) |
| Function parameters too generic | N | input (9), arg (3) |

---

## Step 6 — Cross-Reference With Domain Vocabulary

For each variable that fails, propose a replacement using vocabulary from the glossary or domain-model inventory:

| Original | Context | Proposed |
|----------|---------|---------|
| `const data = ...` (line 23, holds DB result of users table) | service layer | `const userRows` |
| `const result = ...` (line 47, holds calculated price) | billing service | `const computedPrice` |
| `function (input: User)` | parameter | `function (userToValidate: User)` |

---

## Step 7 — Write Findings

Write one JSONL line per naming violation to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "naming"
- `diagnostic_type`: "variable_audit"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Also emit one INFO finding per audited file (pass_count, fail_count, pass_rate).

Example (violation):
{"category":"naming","diagnostic_type":"variable_audit","severity":"MINOR","file_path":"src/services/billing.ts","line_number":23,"description":"Generic variable name: 'const data = await db.select(...)' — holds a user DB result row but name encodes nothing","recommended_action":"Rename to 'const userRows' or 'const billingRecords' based on actual content","finding_signature":"99aabbccddeeff00","confidence":"ai_judged"}

Example (file summary):
{"category":"naming","diagnostic_type":"variable_audit","severity":"INFO","file_path":"src/services/billing.ts","line_number":null,"description":"FILE_AUDIT: 8/12 variables pass domain-naming rules (67% pass rate)","recommended_action":null,"finding_signature":"aabbccddeeff0011","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"variable_audit","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"files_audited":3,"overall_pass_rate":0.0,"overall_verdict":"PASS|PARTIAL|FAIL","status":"complete"}

---

## Step 8 — Highest-Priority Issues

```
1. [file:line] — generic name in [context] — rename to [proposed]
2. [file:line] — boundary variable missing trust level — rename with raw/parsed/validated prefix
3. [recurring pattern] — `result` used 8 times across 3 files — establish convention or rename per occurrence
```

---

Append as final line:
`Status: COMPLETE`
