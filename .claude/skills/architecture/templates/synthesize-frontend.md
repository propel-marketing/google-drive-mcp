# Synthesis — Frontend Hygiene

You are synthesizing frontend hygiene findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize a prioritized remediation plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/frontend-prop-drilling.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/frontend-render-boundary-correctness.jsonl
- `{{PRIOR_FILE_3}}` — diagnose/frontend-component-size-distribution.jsonl
- `{{PRIOR_FILE_4}}` — diagnose/frontend-dead-components.jsonl

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Frontend issues compound — a 600-line component that prop-drills four levels and is also rarely rendered is three problems in one file. Synthesize frontend findings so the remediation plan ranks components by total dysfunction, not by individual symptom.

---

## Step 1 — Detect Empty Frontend

If ALL four upstream files are absent, this codebase has no frontend inventory. Write the following as the entire output and stop:

```json
{"_summary":true,"status":"empty","reason":"No frontend inventory present — frontend synthesis not applicable"}
```

Then on the next line:
```
Status: COMPLETE
```

---

## Step 2 — Read Each Upstream File (Guarded)

```bash
if [ -f "{{PRIOR_FILE_1}}" ]; then
  cat "{{PRIOR_FILE_1}}"
fi
```

Apply the same pattern to `{{PRIOR_FILE_2}}` through `{{PRIOR_FILE_4}}`.

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Skip the trailing `_summary` line

---

## Step 3 — Bucket by Sub-Area and Severity

Group findings into the four sub-areas:

- **prop-drilling** — props passed >2 levels without transformation
- **render-boundary-correctness** — client/server boundary errors, `'use client'` misuse, hydration mismatches
- **component-size-distribution** — components exceeding size budgets
- **dead-components** — components with zero importers

Within each sub-area, sort by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 4 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same component file path appears in 2+ upstream diagnose files. The strongest signal:

- A component in BOTH **component-size-distribution** AND **prop-drilling** = split candidate AND state architecture problem. Highest-leverage refactor target — splitting it AND extracting state to context can resolve up to four findings at once. Top of Do First.
- A component in **render-boundary-correctness** AND **prop-drilling** = boundary mistake compounding with state mistake; fix render boundary first.
- A component in **dead-components** AND any other = delete it (no need to fix what is unused).

Extract these and list them.

---

## Step 5 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Frontend Hygiene

## Summary of Findings
[2-3 sentence overview: worst components, dominant pattern]

## Findings by Area

### Prop Drilling (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Render Boundary Correctness (N findings — X CRITICAL, Y MAJOR)
...

### Component Size Distribution (N findings — X CRITICAL, Y MAJOR)
...

### Dead Components (N findings — X CRITICAL, Y MAJOR)
...

## Cross-Cutting Patterns
- [component file]: appears in [diagnose-A] AND [diagnose-B] — signals [split + state extraction / delete / ...]
- ...

## Prioritized Remediation Plan

### Do First — CRITICAL (N items)

**1. [Finding title]**
- Location: path/to/Component.tsx:LINE
- Action: [imperative action copied from finding]
- Acceptance: [verifiable command copied from finding]
- Effort: XS | S | M | L | XL

...

### Do Next — MAJOR (N items)
...

### Monitor — MINOR (N items)
- [title] — [location]
...
```

Cross-cutting CRITICAL items appear at the top of Do First. Dead components that also appear elsewhere should be listed as "delete instead of fix" to avoid wasted refactor effort.

---

## Step 6 — Append Summary JSON

The final content line of `{{OUTPUT_PATH}}` before `Status: COMPLETE` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","category":"frontend","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N}
```

---

Status: COMPLETE
