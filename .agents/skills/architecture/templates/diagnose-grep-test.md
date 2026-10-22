# Diagnose — Grep Test

You are running the ADW grep test on the 5 most important domain concepts in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files. You will then run actual grep commands against the codebase.
- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/observability.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/schemas.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/observability.jsonl`

---

## What the Grep Test Proves

The grep test is the definition of agent-readability. For a concept to be agent-readable, you must be able to grep its canonical name and follow it — origin, transformation, consumption — without ambiguity. If a concept's name produces mostly noise (unrelated matches), or if the concept has no single name (it's called different things at different layers), the architecture fails the grep test.

**Pass criteria per noun:**
- Origin identifiable from results (one clear definition site)
- Noise ratio below 30% (less than 30% of matches are unrelated to the concept)
- Thread coherent: results tell a recognizable story of origin → transform → consume

**Fail criteria:**
- Zero results (concept was never named)
- Noise ratio 30%+ (name is too generic — `data`, `result`, `response`)
- Origin not identifiable (concept is used everywhere but defined nowhere clearly)
- Name collision (same name used for two different concepts)

---

## Step 1 — Select the 5 Most Important Concepts

From the structures, schemas, and classes inventories, select the 5 concepts that:
1. Span the most layers (appear in DB, service, and API)
2. Have the highest reference count (appear in the most files)
3. Represent the core business domain of this feature (not utilities, not infrastructure)

If the observability inventory includes a grep test, use those concepts as a starting point.

Name each concept by its canonical form from the inventory files.

---

## Step 2 — Run Grep for Each Concept

For each of the 5 concepts, run:

```bash
grep -rn "{ConceptName}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Also check for variant names (if the inventory files show the concept has multiple names across layers):
```bash
grep -rn "{AlternateConceptName}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

---

## Step 3 — Classify Each Result

Read each result line. Classify:

- **ORIGIN** — where the concept is defined (type declaration, schema definition, DB schema row, class definition)
- **TRANSFORM** — where the concept changes shape or moves between layers (service function that takes it as input and returns a modified form, mapping function)
- **CONSUME** — where the concept is used as output (returned in API response, passed to UI, written to DB)
- **IMPORT** — import statement (not a usage, just a reference — count separately)
- **NOISE** — coincidental name match (variable named similarly for unrelated reasons, comment, type parameter that happens to share the name)

---

## Step 4 — Score Each Concept

For each concept:

```
## Concept N: {ConceptName}

Search: grep -rn "{ConceptName}" src/
Results: N total

| File:Line | Classification | What's happening |
|-----------|---------------|-----------------|
| src/db/schema.ts:45 | ORIGIN | Type definition — DB row shape |
| src/services/data/service.ts:112 | TRANSFORM | Mapped from DB row to domain object |
| src/app/api/data/route.ts:78 | CONSUME | Returned in API response |
| src/types/generic.ts:23 | NOISE | Unrelated type parameter named similarly |

Results breakdown: N ORIGIN · N TRANSFORM · N CONSUME · N IMPORT · N NOISE
Noise ratio: N% (NOISE / total - IMPORT)

Thread: [describe in one sentence what the grep results tell you about this concept's journey]

Verdict: PASS | FAIL
Reason: [one sentence — why it passes or fails]
```

**Automatic FAIL conditions:**
- Noise ratio ≥ 30%
- Zero ORIGIN results (concept used but never defined under this name)
- ORIGIN count > 2 (concept defined in multiple places = no single authoritative source)
- Concept appears under a different name at another layer (note the alternate name)

---

## Step 5 — Write Findings

Write one JSONL line per concept tested to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "naming"
- `diagnostic_type`: "grep_test"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: null (grep test is codebase-wide)
- `line_number`: null
- `description`: concept name + verdict + reason
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Also emit one INFO finding per PASS result (so the summary is complete).

Example (FAIL):
{"category":"naming","diagnostic_type":"grep_test","severity":"MAJOR","file_path":null,"line_number":null,"description":"FAIL: 'IntelligenceRaw' noise ratio 84% (67 results, 56 noise) — name is too generic; two ORIGIN definitions found","recommended_action":"Rename to a more specific domain term; consolidate to one definition","finding_signature":"f607112233445566","confidence":"ai_judged"}

Example (PASS):
{"category":"naming","diagnostic_type":"grep_test","severity":"INFO","file_path":null,"line_number":null,"description":"PASS: 'ConversationRow' — 34 results, 6% noise, 1 origin — thread is coherent","recommended_action":null,"finding_signature":"0711223344556677","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"grep_test","total_concepts":5,"passing":0,"failing":0,"overall_verdict":"COHERENT|MUDDY|SEVERELY_MUDDY","status":"complete"}

---

Append as final line:
`Status: COMPLETE`
