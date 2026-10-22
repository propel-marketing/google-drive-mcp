# Inventory — File Structure

You are cataloging the physical structure of the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}` — file sizes by role, file naming patterns, folder naming specificity, and index file roles.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

The existing folder-structure inventory captures organization style and directory layout. This inventory captures the four structural principles that operate at the file level:

1. **File size signals role** — are file sizes consistent with their function, or are non-orchestrators bloated?
2. **File naming mirrors function naming** — do operation files use verb-noun? do holder files use noun?
3. **Naming specificity at depth** — do structural anchors (`types/`, `utils/`) exist below root level?
4. **Index role discipline** — is each index file a barrel, a composition root, or a mixed-responsibility problem?

---

## Step 1 — File Size Census

Get line counts for all source files:

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" | grep -v node_modules | grep -v ".next" | grep -v dist | xargs wc -l 2>/dev/null | sort -rn | head -60
```

For each file, classify its role using these bands:

| Role | Lines | What it should contain |
|------|-------|----------------------|
| `barrel` | 1–15 | Re-export statements only |
| `unit` | 15–80 | One operation, one purpose |
| `manager` | 80–200 | Domain registry, scheduler, lifecycle |
| `complex` | 200–700 | Stateful module with real depth |
| `adapter` | 700–1100 | One external protocol, full surface area |
| `orchestrator` | 1000+ | Composition root or central brain |

**For every file classified `complex`, `adapter`, or `orchestrator`:** read its first 20 lines to verify the classification. If the file constructs and wires multiple collaborators (`new X(...)`, `new Y(...)` passed into another constructor), it is legitimately large. If the first 20 lines are domain logic — a service method, a schema parser, a utility function — flag it.

---

## Step 2 — File Naming Audit

Get all source filenames:

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" | grep -v node_modules | grep -v ".next" | grep -v dist | sed 's|.*/||' | sed 's|\.[^.]*$||' | sort -u
```

For each non-index, non-test filename, classify:

| Pattern | Description | Examples |
|---------|-------------|---------|
| `verb-noun` | Performs a single operation | `read-file`, `git-commit`, `schedule-task`, `cancel-task` |
| `noun` | Holds state or manages a domain | `permissions`, `registry`, `scheduler`, `identity` |
| `role-name` | Fixed structural role | `base`, `index`, `types`, `config` |
| `unclassified` | Doesn't fit a clear pattern | |

Then apply the intent check:
- A file is an **operation** if it exports a single function or factory that performs one action
- A file is a **holder/manager** if it exports a class or set of related functions that manage a domain

**Flag:** any operation file named as a noun. Any holder/manager file named as verb-noun.

To verify intent, read the first export of ambiguous files:

```bash
grep -n "^export" {{CODEBASE_PATH}}/src/<file-path> | head -5
```

---

## Step 3 — Structural Anchor Audit

Find all folder names:

```bash
find {{CODEBASE_PATH}}/src -type d | grep -v node_modules | grep -v ".next" | grep -v dist | sort
```

For each folder, record its depth (count `/` separators from `src/`) and classify:

| Classification | Description |
|---------------|-------------|
| `domain-concept` | Names a thing the system does or is (`filesystem`, `channels`, `soul`, `memory`) |
| `structural-anchor` | Technical organizer appropriate at root only (`types`, `utils`, `helpers`, `cli`, `common`) |
| `catch-all` | Generic name that refuses nothing (`misc`, `shared`, `stuff`) |

**Flag:** any `structural-anchor` found inside a domain folder. Inflection points (`src/`, `packages/`, version prefixes like `v3/`) are valid structural anchors at any depth where they mark the root of a distinct sub-system — they are not violations. Only structural anchors nested inside domain concept folders are flags.

**Flag:** any `catch-all` at any depth.

Depth reference:
- `src/types/` → structural anchor at inflection point → OK
- `packages/run-engine/src/` → `src/` is an inflection point inside a package → OK
- `src/capabilities/types/` → structural anchor inside domain folder `capabilities/` → FLAG
- `src/memory/utils/` → structural anchor inside domain folder `memory/` → FLAG

---

## Step 4 — Index Role Audit

Find all index files:

```bash
find {{CODEBASE_PATH}}/src -name "index.ts" -o -name "index.js" -o -name "__init__.py" -o -name "mod.rs" | grep -v node_modules | grep -v ".next" | grep -v dist | sort
```

For each index file, read it and classify:

| Role | What it contains |
|------|-----------------|
| `barrel` | Only `export { ... } from` or `export * from` statements |
| `composition-root` | `new ClassName()` calls, dependency wiring, application startup |
| `mixed` | Both re-export statements AND construction/logic |

**Flag:** any index classified `mixed` — it is doing two jobs and neither is fully readable.

For the root-level index (typically `src/index.ts`): confirm it is the composition root and document what it constructs. If it is NOT the composition root, find what file is.

---

## Step 5 — Write the Inventory

Write one JSONL line per source file to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "file_structure"
- `kind`: "barrel" | "unit" | "manager" | "complex" | "adapter" | "orchestrator"
- `name`: filename without path (string)
- `file_path`: path relative to codebase root
- `line_number`: 1
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: true
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `line_count`: integer
- `naming_pattern`: "verb-noun" | "noun" | "role-name" | "unclassified"
- `intent`: "operation" | "holder" | "barrel" | "index" | "unknown"
- `is_flagged`: boolean
- `flag_reason`: string | null

Also write one JSONL line per folder:
- `entry_type`: "folder_structure"
- `kind`: "domain-concept" | "structural-anchor" | "catch-all"
- `name`: folder name
- `file_path`: folder path relative to codebase root
- `line_number`: 1
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: false
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"
- `depth`: integer (depth from src/)
- `is_flagged`: boolean
- `flag_reason`: string | null

Also write one JSONL line per index file:
- `entry_type`: "index_file"
- `kind`: "barrel" | "composition-root" | "mixed"
- `name`: "index.ts" or equivalent
- `file_path`, `line_number`: 1, `layer`, `is_exported`: true, `is_test_file`, `confidence`
- `is_flagged`: boolean (true if kind is "mixed")
- `flag_reason`: string | null

Example (file):
{"entry_type":"file_structure","kind":"unit","name":"user-service.ts","file_path":"src/users/user-service.ts","line_number":1,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","line_count":85,"naming_pattern":"noun","intent":"holder","is_flagged":false,"flag_reason":null}

After all entries:
{"_summary":true,"entry_type":"file_structure","total_files":N,"total_folders":N,"flagged_files":0,"flagged_folders":0,"flagged_indexes":0,"composition_root":"src/index.ts","status":"complete"}

---

Append as final line:
`Status: COMPLETE`
