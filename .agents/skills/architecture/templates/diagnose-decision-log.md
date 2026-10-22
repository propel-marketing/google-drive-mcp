# Diagnose — Decision Log

You are checking whether the codebase has a meaningful decision log proportional to its size in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

This diagnostic is discovery-driven via grep. No inventory file input required.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What This Diagnostic Proves

A codebase records its non-obvious decisions in ADRs (Architecture Decision Records). The log is not a journal of every commit — it's the record of decisions a future reader would otherwise reverse-engineer in confusion. Why was this dependency chosen over the alternatives? Why is this boundary drawn here and not there? Why does this exception exist?

The rough heuristic from the code guide: roughly **one decision per 1,000–1,500 lines of code**. Less than that means decisions are not being recorded. Vastly more than that often means routine choices are being over-documented.

This diagnostic checks:
- Does an ADR location exist?
- How many ADRs exist?
- Does the ADR count match the codebase's size?
- Are the ADRs structured (Context / Decision / Consequence)?
- Are recent contested decisions captured?

---

## Step 1 — Find the ADR Location

```bash
# Common ADR locations
ls {{CODEBASE_PATH}}/docs/adr-*.md 2>/dev/null
ls {{CODEBASE_PATH}}/docs/decisions/ 2>/dev/null
ls {{CODEBASE_PATH}}/docs/architecture/decisions/ 2>/dev/null
ls {{CODEBASE_PATH}}/adr/ 2>/dev/null
ls {{CODEBASE_PATH}}/.architecture/decisions/ 2>/dev/null
```

For each location found, count files:

```bash
find {{CODEBASE_PATH}}/docs -name "adr-*.md" 2>/dev/null | wc -l
find {{CODEBASE_PATH}}/docs/decisions -name "*.md" 2>/dev/null | wc -l
```

If no ADR location exists at all: **NO_LOG** — this is the most common failure. Recommend creating `docs/decisions/` and starting with at least one ADR for the most contested decision in the current architecture.

---

## Step 2 — Measure Codebase Size

Get total lines of source code (excluding generated, tests, vendored):

```bash
find {{CODEBASE_PATH}}/src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" \) | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "generated\|__generated__" | xargs wc -l | tail -1
```

Compute expected ADR range:
- Lower bound: total LOC / 1500
- Upper bound: total LOC / 1000

For a 30,000-line codebase, expect 20–30 ADRs.

---

## Step 3 — Compute Coverage Ratio

```
Expected ADRs: {LOC / 1500} to {LOC / 1000}
Actual ADRs: {count}

Coverage:
- Below lower bound → UNDER_LOGGED
- Within range → ADEQUATE
- Above upper bound → OVER_LOGGED (likely documenting routine choices)
```

A small codebase (< 5000 LOC) may legitimately have 0–3 ADRs. A large codebase (50,000+ LOC) without ADRs is a clear violation.

---

## Step 4 — Check ADR Structure

For each ADR found, read the file. Apply the structure check:

| Required section | Check |
|------------------|-------|
| Context | Why this decision was made (forces, constraints, situation) |
| Decision | What was chosen |
| Consequence | What this implies (positive and negative) |

```bash
# Spot-check: do ADRs have these sections?
for file in {{ADR_FILES}}; do
  echo "=== $file ==="
  grep -i "^##.*context\|^##.*decision\|^##.*consequence\|^##.*status" "$file"
done
```

For ADRs missing one or more sections: **STRUCTURE_VIOLATION** — the format isn't being followed; future readers will get partial information.

---

## Step 5 — Check Recency

```bash
# When were ADRs last touched?
find {{CODEBASE_PATH}}/docs -name "adr-*.md" -o -path "*/decisions/*.md" 2>/dev/null | xargs -I {} stat -c "%Y %n" {} 2>/dev/null | sort -n | head -5
find {{CODEBASE_PATH}}/docs -name "adr-*.md" -o -path "*/decisions/*.md" 2>/dev/null | xargs -I {} stat -c "%Y %n" {} 2>/dev/null | sort -rn | head -5
```

For a healthy codebase under active development, expect ADRs added in the last 3–6 months. If the most recent ADR is older than a year and the codebase has clearly evolved (new domains, new dependencies), the log has gone stale.

---

## Step 6 — Spot-Check for Missing Decisions

From a quick scan of the codebase, identify decisions that *should* be ADR-worthy:
- Major framework / runtime choices (Next.js vs Remix vs nothing — should have an ADR)
- Database choice (Postgres vs MongoDB — should have an ADR)
- Auth approach (custom JWT vs Auth.js vs Clerk — should have an ADR)
- Major architectural patterns (event sourcing, CQRS, hexagonal — should have ADRs)
- Significant external dependencies (Stripe vs Lemonsqueezy, OpenAI vs Anthropic vs in-house — should have ADRs)

Cross-check: do the ADRs found cover these decisions?

```bash
grep -li "next.js\|remix\|express\|fastify" {{ADR_LOCATION}}/*.md 2>/dev/null
grep -li "postgres\|mongodb\|sqlite\|mysql" {{ADR_LOCATION}}/*.md 2>/dev/null
grep -li "auth.js\|clerk\|jwt\|cookie" {{ADR_LOCATION}}/*.md 2>/dev/null
```

For each major decision visible in the codebase that lacks an ADR: **MISSING_DECISION** — recommend writing one retrospectively.

---

## Step 7 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "documentation"
- `diagnostic_type`: "decision_log"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"documentation","diagnostic_type":"decision_log","severity":"MAJOR","file_path":null,"line_number":null,"description":"No ADR exists for database choice (Postgres + Drizzle visible in src/db/) — a major architectural decision is undocumented","recommended_action":"Write docs/decisions/001-database-choice.md retrospectively","finding_signature":"c3d4e5f607112233","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"decision_log","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"adr_count":0,"coverage_status":"NO_LOG","status":"complete"}

---

## Step 8 — Highest-Priority Issues

```
1. NO_LOG — create docs/decisions/ and write the first ADR for the most contested decision
2. UNDER_LOGGED — N missing decisions; write at least the top 3 retrospectively (database, auth, AI provider, etc.)
3. INCOMPLETE — N ADRs missing required sections; backfill Context/Decision/Consequence
4. STALE — most recent ADR is N months old; recent code changes likely warrant new ADRs
```

---

Append as final line:
`Status: COMPLETE`
