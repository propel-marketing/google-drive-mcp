# Enrich Issues

You are enriching issue records for **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` with product impact context.

Input:
- Issues: `{{ISSUES_PATH}}` (from assemble-issues phase)
- Journey source: `{{JOURNEY_MAP_PATH}}` if provided, else derive from `{{INV_DIR}}`

Output: `{{OUTPUT_PATH}}` (issues-enriched.jsonl) — same records plus populated `product_impact`, `on_critical_journey`, and `journey_name` fields.

---

## What This Does

Architecture finds technical problems. This phase answers: *does this technical problem affect something a user actually does?* A CRITICAL interface gap in a dead utility is lower real-world priority than a MAJOR naming violation inside the checkout flow.

Two fields are populated per issue:

| Field | Type | Description |
|-------|------|-------------|
| `product_impact` | string | One sentence: what breaks or degrades for the user when this issue is present |
| `on_critical_journey` | boolean | true if the affected file is on a critical or primary user journey |
| `journey_name` | string or null | Name of the critical journey this file participates in |

---

## Step 1 — Verify Issues Input

```bash
[ -f "{{ISSUES_PATH}}" ] && echo "found" || echo "missing"
```

If missing:
```
{"_summary":true,"status":"needs_more_context","reason":"issues.jsonl not found — run assemble-issues first"}
```
Then stop.

Count issues:
```bash
grep -c '"severity"' "{{ISSUES_PATH}}" 2>/dev/null || echo 0
```

---

## Step 2 — Build Journey Map

### If JOURNEY_MAP_PATH is provided and exists:

Read `{{JOURNEY_MAP_PATH}}`. Extract all journey entries — each with:
- `journey_name` (string)
- `criticality` ("critical" | "primary" | "secondary")
- `steps` (array of step objects, each with `file_path` or `component` or `route`)

### If JOURNEY_MAP_PATH is not provided or does not exist:

Derive a minimal journey map from inventory files.

**Step 2a — Read entry points:**

```bash
[ -f "{{INV_DIR}}/entry-points.jsonl" ] && cat "{{INV_DIR}}/entry-points.jsonl" | grep -v '"_summary"' | head -50
```

Extract route paths and handler file_paths. These are the system's entry flows.

**Step 2b — Read frontend components (if present):**

```bash
[ -f "{{INV_DIR}}/frontend-components.jsonl" ] && cat "{{INV_DIR}}/frontend-components.jsonl" | grep -v '"_summary"' | head -50
```

Extract page-level components (those in `pages/`, `app/`, or named `*Page.tsx`, `*Screen.tsx`, `*View.tsx`).

**Step 2c — Derive journeys from routes + pages:**

Group entry points into logical journeys:
- Auth routes (login, signup, logout, reset-password, verify) → journey: "User Authentication"
- Dashboard / home → journey: "Main Dashboard"
- Settings / profile / account → journey: "Account Management"
- Any checkout / payment / billing routes → journey: "Purchase / Payment"
- Any search / browse / list routes → journey: "Content Discovery"
- Any create / edit / submit routes → journey: "Content Creation"
- Admin routes → journey: "Admin Operations"
- API-only routes (no UI counterpart) → journey: "API Integration"
- Remaining ungrouped → journey: "General App"

Assign `criticality`:
- Auth, Purchase/Payment, Main Dashboard → "critical"
- Content Creation, Content Discovery → "primary"
- Account Management, API Integration → "primary"
- Admin Operations, General App → "secondary"

Build a flat list of `{journey_name, criticality, file_paths[]}` — where `file_paths` includes the route file, any service files imported by that route (from internal-imports if available), and any page component.

**Step 2d — Expand with service layer (optional, if internal-imports.jsonl exists):**

```bash
[ -f "{{INV_DIR}}/internal-imports.jsonl" ] && cat "{{INV_DIR}}/internal-imports.jsonl" | grep -v '"_summary"' | head -80
```

For each critical journey's route file, find what service/lib files it imports and add those to the journey's `file_paths`. This propagates journey membership into the service layer.

---

## Step 3 — Build File → Journey Index

From the journey map (built or provided), create an index:

```
file_path → {journey_name, criticality}
```

For fuzzy matching: normalize paths to remove leading `src/`, `./`, `app/` prefixes before indexing. Match issue `file_path` against the index using substring match (an issue at `src/services/auth/UserAuthService.ts` matches a journey entry for `services/auth/UserAuthService.ts`).

---

## Step 4 — Enrich Each Issue (lap swimmer, batches of 20)

Read `{{ISSUES_PATH}}` line by line. For each issue record (skip `_summary`):

1. Look up `file_path` in the file → journey index.
   - If found: `on_critical_journey = (criticality == "critical" or "primary")`, `journey_name = matched journey`
   - If not found: `on_critical_journey = false`, `journey_name = null`

2. Write `product_impact` based on category + severity + journey context:

   **Impact templates by category:**

   | Category | Subcategory | Impact pattern |
   |----------|-------------|----------------|
   | boundary | interface-gaps | "Code calling {class} cannot be replaced or tested in isolation — any defect in {class} propagates unchecked to callers" |
   | boundary | endpoint-drillability | "Diagnosing a live incident in this endpoint requires reading multiple files — mean time to resolution increases" |
   | boundary | boundary-completeness | "Unvalidated input at this boundary can reach the service layer — malformed data causes silent failures or data corruption" |
   | vocabulary-type | grep-test | "Finding where '{term}' is handled requires reading multiple inconsistently named files — adds onboarding friction and slows debugging" |
   | vocabulary-type | type-dissolution | "Runtime type guarantees are absent at this point — type errors surface at runtime as 500s or corrupted responses rather than at compile time" |
   | vocabulary-type | schema-derivation | "Types declared independently of schemas can drift — a schema change silently breaks downstream consumers" |
   | structural | scatter | "Responsibility for {concept} is split across files — a change to {concept} requires coordinating edits in multiple locations" |
   | structural | size-distribution | "File is large enough that locating a specific behavior requires scrolling — slows review and increases merge conflict surface" |
   | coverage | dead-code | "Dead code adds noise to search results and increases cognitive load during debugging" |
   | coverage | decision-log | "Architectural decisions have no rationale recorded — future changes may inadvertently undo deliberate constraints" |
   | frontend | prop-drilling | "Props are passed through intermediate components that don't use them — adding a new prop requires edits at every level" |
   | frontend | render-boundaries | "Render boundary placement means a data-fetch failure here rerenders more of the UI than necessary — increases perceived latency" |
   | test | tier-presence | "Missing test tier means this layer has no automated safety net — regressions go undetected until production" |
   | test | mock-usage | "Mock-heavy tests can pass while the real integration fails — test suite gives false confidence" |
   | test | coverage-vs-journeys | "Critical user journey has no automated test — a regression breaks users before it shows in CI" |

   If on a critical journey: prepend "On the {journey_name} flow: " to the impact string.
   If not on a journey: use the template as-is.

3. Update the record with `product_impact`, `on_critical_journey`, `journey_name`.

4. Append the enriched record to `{{OUTPUT_PATH}}` in append mode.

After each batch of 20: print checkpoint:
```
[enrich] batch {N} — {count} issues enriched ({critical_journey_count} on critical journeys)
```

---

## Step 5 — Rewrite Per-Category Files

For each category that has a `{{ISSUES_DIR}}/issues-{category}.jsonl`:

```bash
for cat in boundary vocabulary-type structural coverage frontend test; do
  f="{{ISSUES_DIR}}/issues-${cat}.jsonl"
  [ -f "$f" ] || continue
  # re-enrich from the enriched file for this category
  python3 -c "
import json
cat = '${cat}'
enriched = {}
with open('{{OUTPUT_PATH}}') as ef:
    for line in ef:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('_summary'): continue
            sig = obj.get('finding_signature') or obj.get('id')
            if sig:
                enriched[sig] = obj
        except: pass

with open('$f', 'w') as out:
    with open('$f') as inp:
        for line in inp:
            pass  # just to get old content — we rewrite
    # write enriched records for this category
    for obj in enriched.values():
        if obj.get('category') == cat:
            out.write(json.dumps(obj) + '\n')
    out.write(json.dumps({'_summary':True,'status':'complete','category':cat}) + '\n')
"
done
```

---

## Step 6 — Write Enriched Summary

Count enrichment coverage:

```bash
python3 -c "
import json
from collections import defaultdict

total = 0
on_critical = 0
with_impact = 0
by_journey = defaultdict(int)

with open('{{OUTPUT_PATH}}') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('_summary'): continue
            total += 1
            if obj.get('on_critical_journey'): on_critical += 1
            if obj.get('product_impact'): with_impact += 1
            jn = obj.get('journey_name')
            if jn: by_journey[jn] += 1
        except: pass

summary = {
    '_summary': True,
    'status': 'complete',
    'total_issues': total,
    'on_critical_journey': on_critical,
    'with_product_impact': with_impact,
    'by_journey': dict(by_journey)
}
print(json.dumps(summary))
" >> "{{OUTPUT_PATH}}"
```

---

## Step 7 — Print Enrichment Report

```
Issues enriched: {total}

  On critical/primary journeys: {N} ({pct}%)
  With product_impact filled:   {N}

Critical journey breakdown:
  {journey_name}: {N} issues
  ...

Files:
  {{OUTPUT_PATH}}

Priority view (CRITICAL + on critical journey):
  {list top 5 issues: severity · category · title · journey_name}
```

---

Append as final line:
`Status: COMPLETE`
