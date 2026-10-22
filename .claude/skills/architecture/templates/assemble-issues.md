# Assemble Issues

You are assembling structured issue records for **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Input: all diagnose JSONL files at `{{DIAGNOSE_DIR}}`.
Output: `{{OUTPUT_PATH}}` (issues.jsonl) and per-category files at `{{ISSUES_DIR}}`.

---

## What This Produces

Each finding from every diagnose file becomes a typed, sortable, enrichment-ready issue record. CRITICAL and MAJOR findings get individual records. MINOR and NOTE findings get individual records but are marked low-priority. All records have `product_impact: null` and `on_critical_journey: null` — ecosystem fills those in.

**Issue record schema:**

```json
{
  "id": "first 16 hex chars of sha256(category:subcategory:file_path:description)",
  "category": "boundary|vocabulary-type|structural|coverage|frontend|test",
  "subcategory": "interface-gaps|grep-test|scatter|...",
  "severity": "CRITICAL|MAJOR|MINOR|NOTE",
  "priority": 1,
  "title": "short descriptive title (≤80 chars)",
  "file_path": "src/...",
  "line_number": null,
  "description": "what was found",
  "fix": "exact action to take",
  "acceptance": "grep-verifiable or compile-verifiable criterion",
  "product_impact": null,
  "on_critical_journey": null,
  "journey_name": null,
  "dependencies": [],
  "source_diagnostic": "diagnose/interface-gaps.jsonl",
  "finding_signature": "c6d4e2f0a8b9c1d3"
}
```

**Priority formula:**

| Severity | Category | Priority |
|----------|----------|----------|
| CRITICAL | boundary or vocabulary-type | 1 |
| CRITICAL | any other | 2 |
| MAJOR | boundary or vocabulary-type | 3 |
| MAJOR | any other | 4 |
| MINOR | any | 5 |
| NOTE | any | 6 |

---

## Step 1 — Verify Inputs

```bash
ls {{DIAGNOSE_DIR}}/*.jsonl 2>/dev/null | wc -l
```

Must return ≥ 20. If fewer than 20 diagnose files exist: write to output:
`{"_summary":true,"status":"needs_more_context","reason":"fewer than 20 diagnose files found — run Phase 2 first"}`
then stop.

---

## Step 2 — Create Output Directories

```bash
mkdir -p "{{ISSUES_DIR}}"
```

Truncate the main output file (write clean slate):
```bash
> "{{OUTPUT_PATH}}"
```

Also prepare per-category output files:
```bash
for cat in boundary vocabulary-type structural coverage frontend test; do
  > "{{ISSUES_DIR}}/issues-${cat}.jsonl"
done
```

---

## Step 3 — Process Diagnose Files (lap swimmer, one file per lap)

**Diagnostic-to-category map:**

| Diagnose file | Category | Subcategory |
|---------------|----------|-------------|
| grep-test.jsonl | vocabulary-type | grep-test |
| variable-audit.jsonl | vocabulary-type | variable-audit |
| glossary-alignment.jsonl | vocabulary-type | glossary-alignment |
| trace.jsonl | vocabulary-type | trace |
| type-dissolution.jsonl | vocabulary-type | type-dissolution |
| schema-derivation.jsonl | vocabulary-type | schema-derivation |
| boundary-completeness.jsonl | boundary | boundary-completeness |
| endpoint-drillability.jsonl | boundary | endpoint-drillability |
| interface-gaps.jsonl | boundary | interface-gaps |
| orchestration-seam.jsonl | boundary | orchestration-seam |
| external-boundary.jsonl | boundary | external-boundary |
| size-distribution.jsonl | structural | size-distribution |
| folder-organization.jsonl | structural | folder-organization |
| index-file-shape.jsonl | structural | index-file-shape |
| naming-specificity.jsonl | structural | naming-specificity |
| composition-root.jsonl | structural | composition-root |
| responsibility-scatter.jsonl | structural | scatter |
| dead-code.jsonl | coverage | dead-code |
| decision-log.jsonl | coverage | decision-log |
| frontend-prop-drilling.jsonl | frontend | prop-drilling |
| frontend-render-boundary-correctness.jsonl | frontend | render-boundaries |
| frontend-component-size-distribution.jsonl | frontend | component-size |
| frontend-dead-components.jsonl | frontend | dead-components |
| test-architecture-tier-presence.jsonl | test | tier-presence |
| test-architecture-folder-mirror.jsonl | test | folder-mirror |
| test-architecture-runner-coherence.jsonl | test | runner-coherence |
| test-architecture-infrastructure-completeness.jsonl | test | infra-completeness |
| test-architecture-mock-usage.jsonl | test | mock-usage |
| test-architecture-coverage-vs-journeys.jsonl | test | coverage-vs-journeys |
| test-architecture-coverage-vs-mover.jsonl | test | coverage-vs-mover |

For each diagnose file that exists, process all findings (non-`_summary` lines) and convert to issue records.

**For each finding line:**

1. Skip the `_summary` line (`"_summary":true`).
2. Map the file's diagnose name to `category` and `subcategory` using the table above.
3. Compute `priority` from severity + category using the priority formula.
4. Build a short `title` from the `description` field (first 80 chars, truncate at word boundary — never truncate inside a word).
5. Assign `fix` from `recommended_action` if present; else derive from `description`.
6. Derive `acceptance` from the fix: make it grep-verifiable or compile-check verifiable. If the fix mentions a rename, acceptance is `grep -rn 'new_name' src/` returns ≥1 result. If the fix mentions adding an interface, acceptance is `grep -rn 'implements InterfaceName'` returns ≥1. If no obvious grep, write: `TypeScript compiles without errors in {file_path}`.
7. Preserve `finding_signature` from the source record if present; else compute as first 16 hex chars of sha256 of `"category:subcategory:file_path:description_normalized"` where description_normalized is description lowercased with punctuation stripped.
8. Set `id` = finding_signature.
9. Set `dependencies`: empty array by default. Exception: type-dissolution findings depend on trace findings that reference the same file_path — add those IDs.
10. Set `source_diagnostic` = the diagnose file name (without path).

Append each issue record as one JSON line to:
- `{{OUTPUT_PATH}}` (all issues)
- `{{ISSUES_DIR}}/issues-{category}.jsonl` (category bucket)

After each file: print a one-line checkpoint:
```
[issues] {filename} → {N} issues emitted ({CRITICAL_COUNT} CRITICAL, {MAJOR_COUNT} MAJOR, {MINOR_COUNT} MINOR, {NOTE_COUNT} NOTE)
```

---

## Step 4 — Sort and Rewrite Main File

After all files are processed, sort `{{OUTPUT_PATH}}` by priority (ascending), then by severity (CRITICAL → MAJOR → MINOR → NOTE), then by category alphabetically:

```bash
# Read all lines, sort by priority field, rewrite
python3 -c "
import json, sys

lines = []
with open('{{OUTPUT_PATH}}') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            lines.append(obj)
        except:
            pass

severity_order = {'CRITICAL': 0, 'MAJOR': 1, 'MINOR': 2, 'NOTE': 3}
lines.sort(key=lambda x: (x.get('priority', 9), severity_order.get(x.get('severity', 'NOTE'), 9), x.get('category', '')))

with open('{{OUTPUT_PATH}}', 'w') as f:
    for obj in lines:
        f.write(json.dumps(obj) + '\n')

print(f'Sorted {len(lines)} issues')
"
```

---

## Step 5 — Deduplicate by finding_signature

Remove any duplicate records sharing the same `finding_signature` (keep first occurrence after sort):

```bash
python3 -c "
import json

seen = set()
output = []
with open('{{OUTPUT_PATH}}') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            sig = obj.get('finding_signature') or obj.get('id', '')
            if sig and sig not in seen:
                seen.add(sig)
                output.append(obj)
        except:
            pass

with open('{{OUTPUT_PATH}}', 'w') as f:
    for obj in output:
        f.write(json.dumps(obj) + '\n')

print(f'After dedup: {len(output)} unique issues')
"
```

---

## Step 6 — Write Summary

Count all issues by severity and category:

```bash
python3 -c "
import json
from collections import defaultdict

by_severity = defaultdict(int)
by_category = defaultdict(int)
total = 0

with open('{{OUTPUT_PATH}}') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            sev = obj.get('severity', 'NOTE')
            cat = obj.get('category', 'unknown')
            by_severity[sev] += 1
            by_category[cat] += 1
            total += 1
        except:
            pass

summary = {
    '_summary': True,
    'status': 'complete',
    'total_issues': total,
    'by_severity': dict(by_severity),
    'by_category': dict(by_category),
    'enrichment_ready': True,
    'product_impact_filled': 0,
    'on_critical_journey_filled': 0
}
print(json.dumps(summary))
" >> "{{OUTPUT_PATH}}"
```

Also write per-category summaries to each `issues-{category}.jsonl`:

```bash
for cat in boundary vocabulary-type structural coverage frontend test; do
  python3 -c "
import json
from collections import defaultdict

by_severity = defaultdict(int)
total = 0
cat = '${cat}'

with open('{{ISSUES_DIR}}/issues-${cat}.jsonl') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            by_severity[obj.get('severity','NOTE')] += 1
            total += 1
        except: pass

print(json.dumps({'_summary':True,'status':'complete','category':cat,'total_issues':total,'by_severity':dict(by_severity)}))
" >> "{{ISSUES_DIR}}/issues-${cat}.jsonl"
done
```

---

## Step 7 — Print Summary Table

```
Issues assembled: {total} total

  CRITICAL  {N}  (priority 1–2)
  MAJOR     {N}  (priority 3–4)
  MINOR     {N}  (priority 5)
  NOTE      {N}  (priority 6)

By category:
  boundary         {N}
  vocabulary-type  {N}
  structural       {N}
  coverage         {N}
  frontend         {N}
  test             {N}

Files:
  {OUTPUT_PATH}
  {ISSUES_DIR}/issues-{category}.jsonl  (×6)

Enrichment: product_impact and on_critical_journey are null — run /ecosystem to enrich.
```

---

Append as final line:
`Status: COMPLETE`
