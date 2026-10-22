# Synthesis — Coverage & Hygiene

You are synthesizing coverage and hygiene findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize a prioritized remediation plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/dead-code.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/decision-log.jsonl

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Dead code and missing decision logs are usually independent findings, but together they signal codebase drift — the team has stopped pruning AND stopped explaining. Synthesize them together because the cleanup task is the same shape: decide whether each artifact is load-bearing, then either document it or delete it.

---

## Step 1 — Read Each Upstream File (Guarded)

```bash
if [ -f "{{PRIOR_FILE_1}}" ]; then
  cat "{{PRIOR_FILE_1}}"
fi
if [ -f "{{PRIOR_FILE_2}}" ]; then
  cat "{{PRIOR_FILE_2}}"
fi
```

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Skip the trailing `_summary` line

---

## Step 2 — Bucket by Sub-Area and Severity

Group findings into the two sub-areas:

- **dead-code** — unreachable code, unused exports, orphan modules
- **decision-log** — significant choices with no recorded rationale (no ADR, comment, or PR link)

Within each sub-area, sort by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 3 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same file or symbol appears in BOTH dead-code AND decision-log outputs. The signal:

- **Dead AND undocumented** = zero documentation of why it exists, zero usage = highest-priority deletion candidate. There is no risk in removing something nobody uses AND nobody wrote down a reason for. Top of Do First.

Extract these and list them.

---

## Step 4 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Coverage & Hygiene

## Summary of Findings
[2-3 sentence overview: how much dead code, how many undocumented decisions, dominant pattern]

## Findings by Area

### Dead Code (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Decision Log (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

## Cross-Cutting Patterns
- [file path or symbol]: appears in dead-code AND decision-log — undocumented AND unused = safe deletion candidate
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
{"_summary":true,"status":"complete","category":"coverage","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N}
```

If both upstream files were absent, write instead:
```json
{"_summary":true,"status":"empty","reason":"No coverage/hygiene diagnose outputs present"}
```

---

Status: COMPLETE
