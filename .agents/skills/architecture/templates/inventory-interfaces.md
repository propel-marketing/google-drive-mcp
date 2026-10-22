# Inventory — Interfaces

You are cataloging every interface declaration in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

Interfaces are pure contracts — what something must do, with nothing about how. They are the seams of the system: deliberate doors where implementations can be swapped without touching anything downstream.

| Find here | Find elsewhere |
|-----------|---------------|
| `interface X { ... }` declarations | `type X = ...` declarations → inventory-types |
| Method signatures inside interfaces | Implementation classes → inventory-classes |
| `extends` relationships between interfaces | Runtime validators → inventory-schemas |
| Generic interfaces (`interface Repository<T>`) | Named domain data shapes → inventory-structures |
| Index signatures (`{ [key: string]: T }`) | Closed value sets → inventory-enums |
| Re-exported interfaces (drift risk) | |
| Duplicate interface names | |

Within interfaces, distinguish two roles:
- **Capability contract** — has methods or function signatures. Declares what something can *do*.
- **Data shape** — only fields, no methods. Declares what data *is*.

Both go in this inventory, tagged by role. `extends_chain_depth` is NOT computed here — the raw extends names are recorded and the diagnose phase resolves depth from the full inventory.

---

## Phase 1 — Discover Interface Files

Run this grep to get the list of files that contain at least one interface declaration. This returns file paths only — do not read any files yet.

```bash
grep -rln "^export interface \|^interface " {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" \
  | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sort
```

Also run these to build lookup sets you will use during file processing:

**Generic interfaces** (file:line pairs):
```bash
grep -rn "^export interface [A-Z][A-Za-z]*<\|^interface [A-Z][A-Za-z]*<" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Index signatures** (file:line pairs):
```bash
grep -rn "\[key: string\]:\|\[key: number\]:\|\[K in \|\[K: " {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Duplicate interface names**:
```bash
grep -rn "^export interface [A-Z][A-Za-z]*\b" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sed 's/.*export interface //' | awk -F'[ <{]' '{print $1}' | sort | uniq -d
```

Store these results in memory. You will consult them as you process each file — do not re-run them per file.

Record the total file count from the first grep. This is your lap count basis.

---

## Phase 2 — Lap Swimmer: Process Files in Batches

Process the file list in batches of **5 files per lap**. For each lap:

**Read each file completely.** Do not use grep -A to extract snippets. Read the full file. This gives you complete import context, all declaration blocks including merged declarations, and accurate field and method counts regardless of declaration length.

For each file, extract every interface declaration:

1. **Identify all interface blocks** — find every `interface` or `export interface` keyword and read to its closing `}` at column 0. TypeScript allows multiple declarations with the same name in the same file (declaration merging) — treat each block separately but flag them as merged.

2. **Determine kind** — scan the body:
   - Any method signatures (lines containing `(` before `:`) → CAPABILITY_CONTRACT
   - Fields only → DATA_SHAPE
   - Mixed → CAPABILITY_CONTRACT (methods dominate)

3. **Count accurately** — count method signatures and field declarations from the actual body, not from grep output.

4. **Record extends names** — if the interface extends one or more interfaces, record all names exactly as written (do not resolve to files; that is the diagnose phase's job).

5. **Determine layer from imports** — read the file's import block. If it imports from React/Next.js/UI libraries → frontend. If it imports from database/ORM/infrastructure libs → infrastructure. If it imports from both → shared. If neither → backend. Path alone is a fallback when imports are ambiguous.

6. **Write JSONL entries immediately** — after processing each file, append entries to `{{OUTPUT_PATH}}`. Do not batch writes across laps.

**After each lap, write a checkpoint to stdout:**
```
Interfaces lap {N}/{TOTAL_LAPS} complete — processed files {START}–{END} of {TOTAL_FILES}, wrote {N_ENTRIES} entries
```

---

## JSONL Schema

One line per interface declaration. Every line must be valid JSON.

Required fields:
- `entry_type`: "interfaces"
- `kind`: "CAPABILITY_CONTRACT" | "DATA_SHAPE"
- `name`: string — interface name exactly as declared
- `file_path`: path relative to codebase root
- `line_number`: integer — line of the `interface` keyword
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "ai_judged"
- `method_count`: integer
- `field_count`: integer
- `is_generic`: boolean — from Phase 1 generic lookup
- `extends`: array of strings — raw names as written, empty array if none
- `has_index_signature`: boolean — from Phase 1 index lookup or body inspection
- `has_duplicate_name`: boolean — from Phase 1 duplicate lookup
- `is_merged_declaration`: boolean — true if another declaration block with this name exists in the same file

Example:
```
{"entry_type":"interfaces","kind":"CAPABILITY_CONTRACT","name":"UserRepository","file_path":"src/users/interfaces.ts","line_number":10,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","method_count":3,"field_count":0,"is_generic":true,"extends":[],"has_index_signature":false,"has_duplicate_name":false,"is_merged_declaration":false}
```

---

## Phase 3 — Summary

After all laps complete, append the summary line:

```
{"_summary":true,"entry_type":"interfaces","total_count":N,"by_kind":{"CAPABILITY_CONTRACT":0,"DATA_SHAPE":0},"generic_count":0,"files_processed":0,"merged_declaration_count":0,"duplicate_name_count":0,"index_signature_count":0,"status":"complete"}
```

Note: `extends_chain_depth` is intentionally absent from this inventory. The diagnose-interface-gaps agent computes depth from the `extends` arrays across the full inventory.

Append as final line:
`Status: COMPLETE`
