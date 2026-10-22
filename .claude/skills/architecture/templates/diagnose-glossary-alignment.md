# Diagnose — Glossary Alignment

You are checking that the vocabulary in the codebase matches the domain glossary in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read these inventory files:
- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/enums.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory files listed above. Each must end with `Status: COMPLETE`.
If any inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/structures.jsonl`
- `{{INV_DIR}}/classes.jsonl`
- `{{INV_DIR}}/enums.jsonl`

If a glossary file exists at `{{CODEBASE_PATH}}/docs/glossary.md` or equivalent, read it. If not, the vocabulary from the inventory files (structures, classes, enums) is the working glossary — use it.

---

## What This Diagnostic Proves

The glossary is the contract between the domain and the code. When the code uses a different word for a concept than the glossary does — or uses the same word for two different concepts — agents (and humans) cannot reliably trace the concept across the codebase. The grep test fails for the wrong reason: not because the concept is muddy, but because the codebase is calling it by a different name than expected.

This diagnostic checks three drift modes:
- **Code uses a synonym not in the glossary** ("project" in code, "job" in glossary)
- **Code uses different names at different layers for one concept** (`UserRow` in DB, `UserDTO` in service, `UserResponse` in API — all the same conceptual user)
- **Code uses one name for two different concepts** (`User` for both authenticated user and customer record)

---

## Step 1 — Establish the Working Glossary

If a glossary file exists, read it. Extract every term and its definition.

If no glossary file, derive a working glossary from the inventory files:
- Every domain entity in the structures inventory (with `Kind: DOMAIN_MODEL`)
- Every concept named in the classes inventory that represents a domain actor
- Every closed set in the enums inventory that names a domain dimension

Write this working glossary at the top of the diagnostic output as the reference being checked against.

---

## Step 2 — Find Synonyms in Code

For each glossary term, search for known synonyms and lookalikes:

```bash
# Common synonym candidates (extend per domain)
# job vs project vs task vs assignment
# customer vs client vs user vs account
# order vs purchase vs transaction
# message vs email vs notification
# estimate vs quote vs proposal
```

For each glossary term `X`, search for likely synonyms in code:

```bash
grep -rn "{synonym1}\|{synonym2}\|{synonym3}" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

If synonyms appear in code but the glossary uses a different canonical word, this is a **SYNONYM_DRIFT** violation. Either:
- The glossary should adopt the code's word
- The code should be renamed to the glossary's word

---

## Step 3 — Find Layer-Variant Names for One Concept

From the inventory files, identify clusters of types that represent the same concept at different layers. Common patterns:

- `XRow` / `XDTO` / `XResponse` / `XRequest` — same concept, different shape per layer
- `RawX` / `ValidatedX` / `PersistedX` — same concept, different trust level
- `XInternal` / `XPublic` — same concept, different visibility

For each cluster, read each definition. Confirm they represent the same concept. Then check:
- Is the layering deliberate? (Different shape per layer is correct.)
- Is the layering accidental? (Same shape, different name, no transformation between them — wasted naming.)
- Are *all* the variants in the glossary, or only the canonical?

```bash
# Find all variants of a concept
for concept in {{GLOSSARY_TERMS}}; do
  grep -rn "type.*${concept}\|interface.*${concept}\|class ${concept}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
done
```

For each cluster of variants without glossary documentation: **LAYER_DRIFT** — the variants are real but the glossary doesn't acknowledge them.

---

## Step 4 — Find Same-Name-Different-Concept Collisions

For every glossary term, find all definitions in code:

```bash
for term in {{GLOSSARY_TERMS}}; do
  grep -rn "^export type ${term}\b\|^export interface ${term}\b\|^export class ${term}\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
done
```

If the same term has two or more definitions in different folders with substantially different shapes (different fields, different methods), this is a **NAME_COLLISION** violation. Two different concepts share a name. The glossary defines one; the other is undocumented and confusing.

For each collision: which one matches the glossary? The other needs renaming.

---

## Step 5 — Find Glossary Terms Missing From Code

For each term in the glossary, confirm it appears in code:

```bash
for term in {{GLOSSARY_TERMS}}; do
  count=$(grep -rn "${term}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | wc -l)
  if [ "$count" -eq 0 ]; then echo "MISSING: $term"; fi
done
```

A glossary term that appears nowhere in code is either:
- An aspirational concept (not yet built) — note in glossary
- A drift indicator (was renamed; glossary not updated)
- Dead vocabulary (no longer used; remove from glossary)

For each missing term: **GLOSSARY_ORPHAN** — flag for resolution.

---

## Step 6 — Cross-Reference With Variable Names

Per `applying-the-code-guide`, variable names should encode domain role and trust level using glossary terms.

Spot-check 3 random files for variable naming:

```bash
find {{CODEBASE_PATH}}/src -type f -name "*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | shuf -n 3
```

Read each file. Are local variables named with glossary terms (`const validatedEstimate`) or with generic terms (`const data`, `const result`)? Generic naming is technically a `diagnose-variable-audit` concern, but glossary leakage manifests here too — variables with glossary-adjacent names that don't match the canonical term (e.g., `const project = ...` when glossary says `job`) is glossary drift in micro-form.

---

## Step 7 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "naming"
- `diagnostic_type`: "glossary_alignment"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"naming","diagnostic_type":"glossary_alignment","severity":"MAJOR","file_path":"src/projects/types.ts","line_number":5,"description":"SYNONYM_DRIFT: code uses 'project' but glossary canonical term is 'job' — 47 uses found","recommended_action":"Pick one canonical term and propagate; update glossary if 'project' is preferred","finding_signature":"e5f6071122334455","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"glossary_alignment","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"synonym_drift_count":0,"name_collision_count":0,"glossary_orphan_count":0,"status":"complete"}

---

## Step 8 — Highest-Priority Issues

```
1. [glossary term] vs [code term] — SYNONYM_DRIFT — pick one canonical and propagate
2. [name] — NAME_COLLISION — rename one definition to match its actual concept
3. [variant cluster] — LAYER_DRIFT — document variants in glossary or consolidate
4. [term] — GLOSSARY_ORPHAN — confirm aspirational vs dead vs renamed
```

---

Append as final line:
`Status: COMPLETE`
