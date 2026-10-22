# Synthesis — Structural Shape & Responsibility

You are synthesizing structural shape and responsibility distribution findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize a prioritized remediation plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/size-distribution.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/folder-organization.jsonl
- `{{PRIOR_FILE_3}}` — diagnose/index-file-shape.jsonl
- `{{PRIOR_FILE_4}}` — diagnose/naming-specificity.jsonl
- `{{PRIOR_FILE_5}}` — diagnose/composition-root.jsonl
- `{{PRIOR_FILE_6}}` — diagnose/responsibility-scatter.jsonl

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Large files, badly named folders, and scattered responsibility usually point to the same root cause: missing boundaries. Synthesize structural findings together because the right split fixes multiple findings at once — a 1200-line file that also fails responsibility-scatter doesn't need two fixes, it needs one decomposition.

---

## Step 1 — Read Each Upstream File (Guarded)

For each `{{PRIOR_FILE_N}}`, guard the read:

```bash
if [ -f "{{PRIOR_FILE_1}}" ]; then
  cat "{{PRIOR_FILE_1}}"
fi
```

Apply the same pattern to `{{PRIOR_FILE_2}}` through `{{PRIOR_FILE_6}}`.

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Skip the trailing `_summary` line

---

## Step 2 — Bucket by Sub-Area and Severity

Group findings into the six sub-areas (one per upstream file):

- **size-distribution** — files exceeding size budgets
- **folder-organization** — folders that group by type instead of by feature, or are misnamed
- **index-file-shape** — index/barrel files that re-export too much or hide structure
- **naming-specificity** — generic filenames (`utils.ts`, `helpers.py`, `common.tsx`)
- **composition-root** — wiring/DI scattered instead of centralized at the app root
- **responsibility-scatter** — single concept implemented across multiple unrelated files

Within each sub-area, sort by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 3 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same file or folder path appears in 2+ upstream diagnose files. The strongest signals:

- A file in BOTH **size-distribution** AND **responsibility-scatter** = clearest split candidate (too large AND doing too many things). Top of Do First.
- A folder in **folder-organization** AND **naming-specificity** = wholesale renaming/restructuring opportunity.
- A file in **index-file-shape** AND **composition-root** = the index file has become an accidental composition root and needs explicit promotion.

Extract these and list them in the cross-cutting section with the diagnose outputs they appear in.

---

## Step 4 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Structural Shape & Responsibility

## Summary of Findings
[2-3 sentence overview: largest files, worst folders, dominant pattern]

## Findings by Area

### Size Distribution (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Folder Organization (N findings — X CRITICAL, Y MAJOR)
...

### Index File Shape (N findings — X CRITICAL, Y MAJOR)
...

### Naming Specificity (N findings — X CRITICAL, Y MAJOR)
...

### Composition Root (N findings — X CRITICAL, Y MAJOR)
...

### Responsibility Scatter (N findings — X CRITICAL, Y MAJOR)
...

## Cross-Cutting Patterns
- [file path]: appears in [diagnose-A] AND [diagnose-B] — signals [split candidate / mis-organized cluster / ...]
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
...

### Monitor — MINOR (N items)
- [title] — [location]
...
```

Cross-cutting CRITICAL items appear at the top of Do First.

---

## Step 5 — Append Summary JSON

The final content line of `{{OUTPUT_PATH}}` before `Status: COMPLETE` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","category":"structural","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N}
```

If every upstream file was absent, write instead:
```json
{"_summary":true,"status":"empty","reason":"No structural diagnose outputs present"}
```

---

Status: COMPLETE
