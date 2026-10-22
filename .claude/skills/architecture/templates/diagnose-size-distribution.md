# Diagnose — Size Distribution

You are checking whether file sizes correctly signal role in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read this inventory file:
- `{{INV_DIR}}/file-structure.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory file listed above. It must end with `Status: COMPLETE`.
If the inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/file-structure.jsonl`

---

## What This Diagnostic Proves

The naïve form of this check — "do file sizes form bands?" — produces false positives. Schema files, registries, generated code, and barrel exports are *legitimately* large because their role is enumerative completeness, not internal complexity. A diagnostic that flags them as decomposition candidates trains the user to ignore signal alongside noise.

The corrected check is two-role: **work-doing files** vs. **aggregation files**.

- **Work-doing files** — perform logic, transformation, computation, behavior. These are subject to the size bands. Their size signals decomposition health.
- **Aggregation files** — enumerate, register, define a boundary, hold reference data, expose a public surface. These are governed by *completeness*, not parsimony. Their natural size is "as large as the thing they enumerate." Splitting them creates incoherence, not cleanliness.

Two checks, two roles, no ad-hoc exemption list.

---

## Step 1 — Classify Every Source File

For each source file, classify as **AGGREGATION** if it matches any of these signals; otherwise **WORK_DOING**.

### Aggregation signals

```bash
# Barrel/composition-root filename pattern
find {{CODEBASE_PATH}}/src -type f \( -name "index.ts" -o -name "index.js" -o -name "index.tsx" -o -name "__init__.py" -o -name "mod.rs" -o -name "lib.rs" \) | grep -v node_modules | grep -v ".next"
```

```bash
# Schema files (filename or content pattern)
find {{CODEBASE_PATH}}/src -type f \( -name "*.schema.ts" -o -name "*.validators.ts" -o -path "*/schemas/*" -o -path "*/validation/*" \) | grep -v node_modules | grep -v ".next"
```

```bash
# Registry / lookup / routes
find {{CODEBASE_PATH}}/src -type f \( -name "routes.ts" -o -name "registry.ts" -o -name "*.registry.ts" -o -name "*.routes.ts" -o -path "*/registries/*" \) | grep -v node_modules | grep -v ".next"
```

```bash
# Constants / reference data
find {{CODEBASE_PATH}}/src -type f \( -name "constants.ts" -o -name "*.constants.ts" -o -path "*/constants/*" -o -path "*/reference-data/*" -o -path "*/lookups/*" \) | grep -v node_modules | grep -v ".next"
```

```bash
# Generated code (header comment marker)
grep -rln "AUTO-GENERATED\|@generated\|DO NOT EDIT\|This file was automatically generated" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
# Generated code (path marker)
find {{CODEBASE_PATH}}/src -type f \( -path "*/generated/*" -o -path "*/__generated__/*" -o -name "*.gen.ts" -o -name "*.generated.ts" \) | grep -v node_modules | grep -v ".next"
```

For files matching any pattern: AGGREGATION. For everything else: WORK_DOING.

### Aggregation sub-type tag

For each AGGREGATION file, tag its sub-type:
- `BARREL` — index file that only re-exports
- `COMPOSITION_ROOT` — entry point that wires the system
- `SCHEMA` — runtime validators
- `REGISTRY` — lookup tables, route maps, command tables
- `REFERENCE_DATA` — constants, enums-as-data, lookup arrays
- `GENERATED` — produced by a tool, hand-edits forbidden
- `TYPE_AGGREGATION` — comprehensive types.ts for one domain

---

## Step 2 — Check Work-Doing Files Against Bands

Get line counts for all WORK_DOING files:

```bash
wc -l {{WORK_DOING_FILES}} | sort -n
```

The expected bands (TypeScript baseline; adjust ±30% for denser/sparser languages):

| Band | Range | Role |
|------|-------|------|
| Single-operation unit | 12–50 | One operation, one tool |
| Domain manager | 50–200 | Coordinates state for one concept |
| Complex stateful module | 200–700 | Non-trivial state, multiple operations |
| Protocol adapter | 500–1100 | Translates between protocol and internal model |
| Stateful infrastructure | 1000+ | Coordinates state across processes |

Pass criteria:
- **PASS** — file sizes form distinct populations matching the bands
- **MUDDY** — sizes form a smooth slope from 50–800 with no clear gaps
- **OUTLIER** — files in gap zones (e.g., 280 lines — past manager, below complex stateful)

For each file in a gap zone, read its responsibilities. Either:
- The file is doing two things and should split (move to band)
- The file is legitimately the right size and the band is too narrow for this codebase

---

## Step 3 — Check Aggregation Files for Single-Purpose

For each AGGREGATION file, verify single-purpose role. Read each file and answer:

| Sub-type | Single-purpose test |
|----------|--------------------|
| BARREL | Contains only `export ... from ...` lines? Any function/class declarations are a violation. |
| COMPOSITION_ROOT | Only wiring (instantiations, registrations, runtime start)? Domain logic inside is a violation. |
| SCHEMA | Only schema declarations and the inferred types? Logic, transformations, or business rules are a violation. |
| REGISTRY | Only entries in a map/array? Conditional logic that decides registration is a violation. |
| REFERENCE_DATA | Only literal data structures? Functions or imports of runtime modules are a violation. |
| GENERATED | Has the AUTO-GENERATED header? Hand-edits below the header are a violation. |
| TYPE_AGGREGATION | Only type/structure declarations? Function bodies or runtime values are a violation. |

For each violation: this file mixes roles and the size signal becomes meaningless until the roles are separated.

---

## Step 4 — Identify Mixed-Role Files

These are work-doing files that *also* contain aggregation (a service module with a 200-line lookup table inlined at the top, or a barrel that has crept logic into it).

```bash
# Files that have both substantial logic AND substantial constant blocks
# (heuristic: more than 50 lines of `const X = { ... }` literals + more than 50 lines of function bodies)
```

For each candidate, read the file. If both roles are present and substantial, recommend extraction of the aggregation portion into its own file. The mix invalidates the size signal for the work-doing portion.

---

## Step 5 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "structure"
- `diagnostic_type`: "size_distribution"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"structure","diagnostic_type":"size_distribution","severity":"MINOR","file_path":"src/services/billing.ts","line_number":1,"description":"MIXED_ROLE: work-doing file contains 180-line TAX_RATES_BY_REGION constant block — invalidates band signal for the work-doing portion","recommended_action":"Extract constant to src/services/billing-tax-rates.ts","finding_signature":"5566778899aabb00","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"size_distribution","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"distribution_shape":"BANDS|MUDDY_SLOPE","mixed_role_count":0,"status":"complete"}

---

## Step 6 — Highest-Priority Issues

```
1. [file] — [violation type] — [what to do]
2. [file] — [violation type] — [what to do]
...
```

Priority order:
1. Mixed-role files (invalidate the band check entirely)
2. Aggregation files violating single-purpose (silent role corruption)
3. Work-doing outliers in gap zones (decomposition candidates)
4. Smooth-slope distribution overall (structural debt across codebase)

---

Append as final line:
`Status: COMPLETE`
