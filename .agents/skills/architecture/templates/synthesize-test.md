# Synthesis — Test Architecture

You are synthesizing test architecture findings for the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

You do NOT re-run analysis on the codebase. You only READ the Phase 3 diagnose JSONL files and synthesize an actionable test improvement plan.

Read upstream diagnose files (each may or may not exist — guard every read):
- `{{PRIOR_FILE_1}}` — diagnose/test-architecture-tier-presence.jsonl
- `{{PRIOR_FILE_2}}` — diagnose/test-architecture-folder-mirror.jsonl
- `{{PRIOR_FILE_3}}` — diagnose/test-architecture-runner-coherence.jsonl
- `{{PRIOR_FILE_4}}` — diagnose/test-architecture-infrastructure-completeness.jsonl
- `{{PRIOR_FILE_5}}` — diagnose/test-architecture-mock-usage.jsonl
- `{{PRIOR_FILE_6}}` — diagnose/test-architecture-coverage-vs-journeys.jsonl
- `{{PRIOR_FILE_7}}` — diagnose/test-architecture-coverage-vs-mover.jsonl

Write synthesis output to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Principle

A test architecture audit fails not when there are no tests, but when the tests that exist don't cover the units that matter. The synthesis must name the specific routes and services that have no real coverage and the tier (UNIT, INTEGRATION, E2E) they need.

---

## Step 1 — Detect Empty Test Surface

If ALL seven upstream files are absent, write the following as the entire output and stop:

```json
{"_summary":true,"status":"empty","reason":"No test architecture diagnose outputs present"}
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

Apply the same pattern to `{{PRIOR_FILE_2}}` through `{{PRIOR_FILE_7}}`.

For each file that exists:
- Parse each non-`_summary` JSONL line as a finding record
- Skip the trailing `_summary` line

---

## Step 3 — Bucket by Sub-Area and Severity

Group findings into the seven sub-areas:

- **tier-presence** — missing tier (no UNIT, no INTEGRATION, no E2E)
- **folder-mirror** — test folders don't mirror source folders
- **runner-coherence** — multiple test runners with overlapping responsibilities, mis-configured
- **infrastructure-completeness** — missing fixtures, factories, harnesses, test DB setup
- **mock-usage** — tests that mock everything, exercising no real code
- **coverage-vs-journeys** — user journeys (entry points) with no E2E or integration coverage
- **coverage-vs-mover** — services/movers with no unit coverage

Within each sub-area, sort by severity: CRITICAL > MAJOR > MINOR > NOTE.

---

## Step 4 — Identify Cross-Cutting Patterns

A finding is **cross-cutting** if the same route/service appears in 2+ upstream diagnose files. Strongest signals:

- A service in BOTH **coverage-vs-mover** AND **mock-usage** = doubly uncovered. The tests exist but are fake — they mock the unit under test or all its dependencies. Highest-priority real test target. Top of Do First.
- A route in **coverage-vs-journeys** AND **infrastructure-completeness** = no E2E AND no infrastructure to write one. Indicates a bigger investment is needed before tests can be added.
- A folder in **folder-mirror** AND **runner-coherence** = the test layout itself is broken; restructuring unlocks everything else.

Extract these and list them.

---

## Step 5 — Tally Coverage Gaps

Count from the upstream records:
- `uncovered_routes` — distinct routes flagged in coverage-vs-journeys
- `uncovered_services` — distinct services flagged in coverage-vs-mover
- `mock_candidates` — tests flagged in mock-usage that should be rewritten with real fixtures

These feed into the `_summary` JSON.

---

## Step 6 — Write the Synthesis Markdown

Write to `{{OUTPUT_PATH}}` using this exact structure:

```markdown
# Synthesis — Test Architecture

## Summary of Findings
[2-3 sentence overview: which tiers are missing, how many routes/services uncovered, dominant pattern]

## Findings by Area

### Tier Presence (N findings — X CRITICAL, Y MAJOR)
[Brief description]
- **CRITICAL:** [title] — [location] — [1-line description]
- **MAJOR:** [title] — [location] — [1-line description]

### Folder Mirror (N findings — X CRITICAL, Y MAJOR)
...

### Runner Coherence (N findings — X CRITICAL, Y MAJOR)
...

### Infrastructure Completeness (N findings — X CRITICAL, Y MAJOR)
...

### Mock Usage (N findings — X CRITICAL, Y MAJOR)
...

### Coverage vs Journeys (N findings — X CRITICAL, Y MAJOR)
...

### Coverage vs Mover (N findings — X CRITICAL, Y MAJOR)
...

## Cross-Cutting Patterns
- [route or service]: appears in [diagnose-A] AND [diagnose-B] — signals [doubly uncovered / real test target / ...]
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

## Step 7 — Append Summary JSON

The final content line of `{{OUTPUT_PATH}}` before `Status: COMPLETE` MUST be a single-line JSON record:

```json
{"_summary":true,"status":"complete","category":"test","findings_total":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"NOTE":0},"remediation_items":N,"cross_cutting_patterns":N,"uncovered_routes":N,"uncovered_services":N,"mock_candidates":N}
```

---

Status: COMPLETE
