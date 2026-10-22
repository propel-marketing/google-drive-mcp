# Synthesis — Vocabulary & Type Integrity

You are synthesizing vocabulary coherence and type integrity findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize a prioritized remediation plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/grep-test.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/variable-audit.jsonl
- `{{PRIOR_FILE_3}}` — diagnose/glossary-alignment.jsonl
- `{{PRIOR_FILE_4}}` — diagnose/trace.jsonl
- `{{PRIOR_FILE_5}}` — diagnose/type-dissolution.jsonl
- `{{PRIOR_FILE_6}}` — diagnose/schema-derivation.jsonl

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Vocabulary drift and type dissolution are the same disease in different layers. A file where domain terms are inconsistent is usually the same file where types are anemic or stringly-typed. Synthesize these together so the remediation plan addresses both in one pass instead of fixing the same file twice.

---

## Step 1 — Read Each Upstream File (Guarded)

For each `{{PRIOR_FILE_N}}`, guard the read:

```bash
if [ -f "{{PRIOR_FILE_1}}" ]; then
  cat "{{PRIOR_FILE_1}}"
fi
```

Apply the same pattern to `{{PRIOR_FILE_2}}` through `{{PRIOR_FILE_6}}`. If a file is absent, skip silently — that diagnose either had no input inventory or was not applicable.

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Collect `severity`, `principle`, `location`, `description`, `action`, `acceptance`, `effort`
- Skip the trailing `_summary` line (used for counts only)

---

## Step 2 — Bucket by Severity and Sub-Area

Group findings into the six sub-areas (one per upstream file):

- **grep-test** — terms used in code but undefined in glossary, or vice versa
- **variable-audit** — variables whose names contradict their values
- **glossary-alignment** — domain terms inconsistent across files
- **trace** — name changes mid-flow (e.g. `userId` → `accountId` with no transformation)
- **type-dissolution** — types collapsed to `any`, `string`, `unknown`, dict[str, Any], etc.
- **schema-derivation** — schemas hand-written instead of derived from the canonical type

Within each sub-area, sort findings by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 3 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same file path appears in two or more upstream diagnose files. The strongest signal:

- A file in both **vocabulary** (grep-test/variable-audit/glossary-alignment/trace) AND **type** (type-dissolution/schema-derivation) outputs — this file has both naming and type problems and should be fixed together.

Extract these locations and list them in the cross-cutting section. Each cross-cut entry should name the file and the two (or more) diagnose outputs it appears in.

---

## Step 4 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Vocabulary & Type Integrity

## Summary of Findings
[2-3 sentence overview: how many findings, where the worst concentrations are, what the dominant pattern is]

## Findings by Area

### Grep Test — Term Coverage (N findings — X CRITICAL, Y MAJOR)
[Brief description of what this sub-area covers and what was found]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Variable Audit — Name vs Value (N findings — X CRITICAL, Y MAJOR)
...

### Glossary Alignment (N findings — X CRITICAL, Y MAJOR)
...

### Trace — Name Stability Across Flow (N findings — X CRITICAL, Y MAJOR)
...

### Type Dissolution — Anemic Types (N findings — X CRITICAL, Y MAJOR)
...

### Schema Derivation — Hand-Written Schemas (N findings — X CRITICAL, Y MAJOR)
...

## Cross-Cutting Patterns
- [file path]: appears in [diagnose-A] AND [diagnose-B] — signals [naming AND type drift in same module]
- ...

## Prioritized Remediation Plan

### Do First — CRITICAL (N items)

**1. [Finding title]**
- Location: path/to/file.ts:LINE
- Action: [imperative action copied from finding]
- Acceptance: [verifiable command copied from finding]
- Effort: XS | S | M | L | XL

...

### Do Next — MAJOR (N items)

**1. [Finding title]**
- Location: path/to/file.ts:LINE
- Action: ...
- Acceptance: ...
- Effort: ...

...

### Monitor — MINOR (N items)
- [title] — [location]
- [title] — [location]
...
```

Sort CRITICAL/MAJOR items so cross-cutting items appear first within their severity band.

---

## Step 5 — Append Summary JSON

The final content line of `{{OUTPUT_PATH}}` before `Status: COMPLETE` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","category":"vocabulary-type","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N}
```

Where:
- `findings_total` = sum of all non-`_summary` records read across the 6 upstream files
- `by_severity` = total per severity across all read files
- `remediation_items` = count of items appearing in Do First + Do Next sections (CRITICAL + MAJOR)
- `cross_cutting_patterns` = number of file paths that appeared in 2+ upstream diagnose files

If every upstream file was absent, write instead:
```json
{"_summary":true,"status":"empty","reason":"No vocabulary or type diagnose outputs present"}
```

---

Status: COMPLETE
