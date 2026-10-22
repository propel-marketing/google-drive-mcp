# Synthesis — Boundary Hygiene

You are synthesizing boundary hygiene findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize a prioritized remediation plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/boundary-completeness.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/endpoint-drillability.jsonl
- `{{PRIOR_FILE_3}}` — diagnose/interface-gaps.jsonl
- `{{PRIOR_FILE_4}}` — diagnose/orchestration-seam.jsonl (may be absent)
- `{{PRIOR_FILE_5}}` — diagnose/external-boundary.jsonl (may be absent)

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

Boundary failures are often the highest-severity category in any audit — exposed endpoints, missing auth, untyped contracts, and leaky seams compromise the entire system, not just one file. Synthesize these findings into a single boundary remediation plan because a missing auth check and a missing schema on the same endpoint are one problem with two faces.

---

## Step 1 — Read Each Upstream File (Guarded)

For each `{{PRIOR_FILE_N}}`, guard the read:

```bash
if [ -f "{{PRIOR_FILE_1}}" ]; then
  cat "{{PRIOR_FILE_1}}"
fi
```

Apply the same pattern to `{{PRIOR_FILE_2}}` through `{{PRIOR_FILE_5}}`. Orchestration-seam and external-boundary may legitimately not exist for simpler codebases.

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Skip the trailing `_summary` line

---

## Step 2 — Bucket by Sub-Area and Severity

Group findings into the five sub-areas (one per upstream file):

- **boundary-completeness** — endpoints/handlers missing auth, validation, or error envelope
- **endpoint-drillability** — endpoints whose handlers cannot be traced from route to service
- **interface-gaps** — typed boundaries with `any`, missing return types, or untyped errors
- **orchestration-seam** — internal seams between subsystems that leak implementation
- **external-boundary** — third-party calls without typed wrappers, retries, or fault isolation

Within each sub-area, sort by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 3 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same endpoint/handler appears in 2+ upstream diagnose files. The strongest signal:

- An endpoint in BOTH **boundary-completeness** AND **interface-gaps** = contract gap. Unprotected at runtime AND untyped at compile time. Flag at highest priority — these belong at the top of the Do First section regardless of original severity, since the combination is worse than either alone.
- An endpoint in **endpoint-drillability** AND any other = the handler is hard to read AND has a defect — fix readability first to unlock the other fix.
- A service appearing in **orchestration-seam** AND **external-boundary** = the same seam is leaky inward and outward.

Extract these and list them in the cross-cutting section with the diagnose outputs they appear in.

---

## Step 4 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Boundary Hygiene

## Summary of Findings
[2-3 sentence overview: how many findings, which endpoints/seams are worst, what the dominant pattern is]

## Findings by Area

### Boundary Completeness (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Endpoint Drillability (N findings — X CRITICAL, Y MAJOR)
...

### Interface Gaps (N findings — X CRITICAL, Y MAJOR)
...

### Orchestration Seam (N findings — X CRITICAL, Y MAJOR)
[If file absent, write: "Not evaluated — orchestration-seam diagnose not present"]
...

### External Boundary (N findings — X CRITICAL, Y MAJOR)
[If file absent, write: "Not evaluated — external-boundary diagnose not present"]
...

## Cross-Cutting Patterns
- [endpoint or seam]: appears in [diagnose-A] AND [diagnose-B] — signals [contract gap / leaky seam / ...]
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
{"_summary":true,"status":"complete","category":"boundary","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N}
```

If every upstream file was absent, write instead:
```json
{"_summary":true,"status":"empty","reason":"No boundary diagnose outputs present"}
```

---

Status: COMPLETE
