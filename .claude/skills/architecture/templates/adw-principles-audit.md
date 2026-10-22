# ADW Principles Holistic Audit

You are the final checkpoint for an ADW audit of **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Your job: read every ADW principle from every reference file, then verify that each principle was checked, findings were captured, and remediations are in the plan. If anything fell through — a principle never audited, a finding never translated, a violation in the plan with no remediation — flag it.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference Files

Read ALL of these before beginning. They are the ground truth for what "correct" looks like.

{{EMBEDDED_REFERENCE}}

---

## Audit Inputs

If any file is missing or incomplete, note it and continue — audit what you can, flag what's missing.

**Diagnose outputs:**
{{DIAGNOSE_FILES}}

Each diagnose file is a JSONL file — confirm the last non-empty line of each parses as JSON with `"_summary":true` and `"status":"complete"`. Note any that are missing or incomplete.

**Gap analysis:**
{{REFLECT_AND_MAP_PATH}}

Confirm this file ends with `Status: COMPLETE` before proceeding.

---

## Instructions

Do not re-read source files. Do not re-run greps. The inputs above are your complete picture of the codebase. Your job is to audit the audit — not the code.

For every principle in every reference file, ask three questions:

1. **Was it checked?** — Did Phase 1 (inventory scouts), Phase 3 (diagnose agents), or Phase 4 (reflect-and-map) explicitly look for this?
2. **Was it found?** — If checked, what did the audit find? Violations, gaps, or clean?
3. **Is it addressed?** — If violations were found, does the remediation plan include specific fixes?

Flag anything where the answer to any of these is NO or UNKNOWN.

---

## Step 1 — Principles Coverage Matrix

Work through each reference file section by section. For every named principle or rule, produce one row:

```
## 01-principle.md — Agent Readability & The Grep Test

| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| Grep test: core nouns traceable end-to-end | diagnose-grep-test.md | N/5 pass — MUDDY | YES — renaming items in plan | COVERED |
| Variable names reflect domain role not type | inventory-observability, diagnose-scatter | N violations found | YES — renaming items in plan | COVERED |
| One authoritative name per concept per layer | diagnose-grep-test, inventory-types | Multiple origin sites for ConceptX | PARTIAL — plan renames type but not schema variant | GAP |
```

## 02-building-blocks.md — Types, Structures, Schemas, Interfaces, Classes, Enums

| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| Every type derived from schema (z.infer) | inventory-types, inventory-type-aliases | N types declared independently | YES | COVERED |
| Every interface has clear role (capability vs data shape) | inventory-interfaces | N interfaces with mixed roles | YES | COVERED |
| Every class has named interface | inventory-classes | N classes without interface | YES | COVERED |
| Every closed value set is a named enum | inventory-enums, inventory-magic-strings | N magic string clusters | YES | COVERED |
| Every DB row has Row suffix | inventory-structures, inventory-domain-models | ... | ... | ... |
| Every API response has Response suffix | inventory-structures, inventory-data-transfer-objects | ... | ... | ... |
| Schemas validated at every entry point | inventory-entry-points | ... | ... | ... |
| No `any` / type dissolution in trusted code | inventory-types, inventory-type-dissolution | ... | ... | ... |
| Type guards use runtime checks (not trust-me casts) | inventory-type-operations | ... | ... | ... |
| Error types are named, specific, and caught | inventory-error-types, inventory-try-catch-flow | ... | ... | ... |
| SDK imports are concentrated in adapter files | inventory-external-imports | ... | ... | ... |
| No layer inversion in import graph | inventory-internal-imports | ... | ... | ... |
| Magic numbers replaced with named constants | inventory-magic-numbers | ... | ... | ... |
| Env vars read through validated config module | inventory-config | ... | ... | ... |

## 03-observability.md — Typed Results, Boundary Printing, Tracking Messages, Drillability

| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| Service functions return OperationResult<T> | inventory-observability or inventory-result-types | ... | ... | ... |
| Both success and failure carry TrackingMessage | inventory-observability or inventory-result-types | ... | ... | ... |
| Boundary logging: class+method+inputs+outcome+duration | inventory-observability or inventory-log-calls | ... | ... | ... |
| Exception handlers log full context (stack + inputs) | inventory-observability, inventory-log-calls, inventory-try-catch-flow | ... | ... | ... |
| Endpoint drillability: 4 questions answerable from 1 file | inventory-entry-points, inventory-observability | ... | ... | ... |
| Log calls include sufficient context (FULL quality) | inventory-log-calls | ... | ... | ... |
| Trace spans set attributes and record errors | inventory-trace-spans | ... | ... | ... |
| Metric emissions include tags for filtering | inventory-metric-emissions | ... | ... | ... |
| Error reports include user context and extra context | inventory-error-reports | ... | ... | ... |

## 04-diagnostics.md — Six Diagnostic Checks

| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| [Each diagnostic check from 04-diagnostics.md] | ... | ... | ... | ... |

## 05-construction.md — Seven Construction Steps

| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| [Each construction step from 05-construction.md] | ... | ... | ... | ... |
```

**Status values:**
- `COVERED` — checked, finding recorded, in remediation plan (or clean — no finding needed)
- `PARTIAL` — checked but finding not fully translated to remediation item
- `GAP` — principle exists but was NOT checked in this audit
- `FINDING_MISSING` — checked, violation found, but NOT in remediation plan
- `CLEAN` — checked, no violations found

---

## Step 2 — Gaps Found

List every row where Status is `GAP`, `PARTIAL`, or `FINDING_MISSING`:

```
## Gaps in This Audit

### GAP — Not checked
These principles were in the ADW reference files but no audit phase looked for them:
1. [principle from which reference file] — [why it matters, what to look for]
2. ...

### PARTIAL — Checked but finding not fully addressed
These were found but the remediation plan doesn't fully cover them:
1. [principle] — [what was found] — [what the plan is missing]
2. ...

### FINDING_MISSING — Violation found but not in plan
These violations appear in diagnose outputs but have no remediation item:
1. [violation at file:line] — [from which output] — [what remediation is needed]
2. ...
```

---

## Step 3 — Remediation Plan Completeness

Read `reflect-and-map.md`. For each CRITICAL and MAJOR remediation item, verify:
- The file:line is specific (not "somewhere in src/services")
- The action is exact (RENAME, CREATE, DERIVE, MOVE, EXTRACT — not "improve" or "consider")
- The acceptance criterion is clear (what does "done" look like?)

Flag any remediation item that is vague, missing a file:line, or has no clear done condition:

```
## Vague Remediation Items

| Item | Issue | What It Needs |
|------|-------|--------------|
| "Improve naming in service layer" | No file:line, no specific rename | List exact variable names and target names |
| "Add observability" | No specifics | Which functions, which pattern (OperationResult<T>?) |
```

---

## Step 4 — Final Verdict

```
## ADW Principles Holistic Audit — Final Verdict

Feature: {{FEATURE_NAME}}
Codebase: {{CODEBASE_PATH}}

Principles audited: N total
  COVERED (checked + in plan or clean): N
  PARTIAL (checked but incompletely addressed): N
  GAP (not checked at all): N
  FINDING_MISSING (found but not in plan): N
  CLEAN (checked, no violations): N

Audit completeness: N% (COVERED + CLEAN) / total

Vague remediation items: N

Overall verdict: COMPLETE | GAPS_FOUND | INCOMPLETE

  COMPLETE: ≥90% COVERED/CLEAN, zero GAPs on CRITICAL principles, zero FINDING_MISSING
  GAPS_FOUND: Some principles unchecked or findings not fully addressed — see Gap list
  INCOMPLETE: >20% of principles have GAP or FINDING_MISSING status

Recommended follow-up:
[List specific gaps to close before running audit-to-spec, or "None — ready for audit-to-spec"]
```

---

Append as final line:
`Status: COMPLETE`
