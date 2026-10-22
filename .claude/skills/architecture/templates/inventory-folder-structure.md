# Inventory — Folder Structure

You are cataloging the actual directory organization of the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Folder structure is the first thing an agent sees when it enters a codebase. A well-organized codebase telegraphs its architecture from the directory tree alone — an agent can predict where a service, schema, or type lives without searching.

Find and assess ALL of these:

1. **Top-level structure** — what directories exist at `src/` and one level deep
2. **Feature vs. layer organization** — is code organized by technical layer (`services/`, `components/`, `types/`) or by domain feature (`ai-assistant/`, `billing/`, `auth/`)?
3. **Colocation patterns** — are types, schemas, and services colocated with the feature they serve, or centralized?
4. **Naming conventions** — kebab-case vs. camelCase vs. PascalCase for folders and files
5. **Index file usage** — are there `index.ts` barrel files? Do they help or obfuscate?
6. **Orphaned files** — files that don't fit any pattern; loose TypeScript files at unexpected depths
7. **Deep nesting** — paths that require 4+ levels of navigation to reach a file (cognition cost)

---

## Step 1 — Map the Top-Level Structure

```bash
find {{CODEBASE_PATH}}/src -maxdepth 1 -type d | sort
```

```bash
find {{CODEBASE_PATH}}/src -maxdepth 2 -type d | sort
```

List all directories. Note what each top-level directory appears to contain based on its name.

---

## Step 2 — Map the Full Tree (One Level Deeper)

```bash
find {{CODEBASE_PATH}}/src -maxdepth 3 -type d | sort
```

For any directory that appears domain-specific (not generic like `components`, `utils`, `types`), read its contents:

```bash
ls {{CODEBASE_PATH}}/src/<domain-dir>/
```

---

## Step 3 — Count Files per Directory

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30
```

Directories with many files (>10) are candidates for further subdivision. Directories with 1–2 files may indicate over-engineering.

---

## Step 4 — Identify Organization Style

Determine whether the codebase uses **layer-based** or **feature-based** organization:

- Layer-based: `src/services/`, `src/types/`, `src/components/`, `src/api/` — all features share these directories
- Feature-based: `src/ai-assistant/`, `src/billing/`, `src/auth/` — each feature owns its own types, services, components
- Hybrid: some domains have feature directories; shared utilities live in layer directories

Note the actual organization observed.

---

## Step 5 — Find Naming Convention Violations

Check file naming patterns:

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".next" | sed 's|.*/||' | sort | grep -E "^[A-Z]" | head -20
```

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".next" | sed 's|.*/||' | sort | grep -E "_" | head -20
```

What is the dominant convention? What are the exceptions?

---

## Step 6 — Find Index Barrel Files

```bash
find {{CODEBASE_PATH}}/src -name "index.ts" | grep -v node_modules | grep -v ".next" | sort
```

For each `index.ts`: read it. Is it a simple re-export barrel, or does it contain logic? Does it help (centralizes a module's public API) or hurt (hides where symbols are actually defined, making grep harder)?

---

## Step 7 — Find Deep Nesting (4+ levels)

```bash
find {{CODEBASE_PATH}}/src -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".next" | awk -F/ '{print NF-1, $0}' | sort -rn | head -20
```

Files at depth 6+ from the repository root are candidates for refactoring. Note any.

---

## Step 8 — Find Orphaned / Misplaced Files

Files at unexpected locations — e.g., a schema file inside a `components/` directory, or a utility function inside `api/`:

```bash
find {{CODEBASE_PATH}}/src -maxdepth 1 -name "*.ts" | grep -v node_modules | grep -v ".next"
```

```bash
find {{CODEBASE_PATH}}/src/app -name "*.ts" | grep -v "route.ts\|page.tsx\|layout.tsx\|loading.tsx\|error.tsx" | grep -v node_modules | grep -v ".next" | head -20
```

---

## Step 9 — Write the Inventory

Write one JSONL line per directory to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "folder_structure"
- `kind`: "domain-concept" | "structural-anchor" | "catch-all" | "inflection-point"
- `name`: directory name (string)
- `file_path`: directory path relative to codebase root
- `line_number`: 1
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `depth`: integer (depth from src/, 1 = immediate child of src/)
- `ts_file_count`: integer (number of .ts/.tsx files in directory)
- `naming_convention`: "kebab-case" | "camelCase" | "PascalCase" | "snake_case" | "mixed"
- `is_flagged`: boolean
- `flag_reason`: string | null (e.g., "structural-anchor inside domain folder" or "catch-all name")

Also emit one codebase-level summary entry first:
- `entry_type`: "codebase_overview"
- `kind`: "layer-based" | "feature-based" | "hybrid"
- `name`: "codebase_overview"
- `file_path`: null, `line_number`: 0, `layer`: "shared", `is_exported`: false, `is_test_file`: false, `confidence`: "ai_judged"
- `total_directories`: integer
- `total_ts_files`: integer
- `file_naming_convention`: "kebab-case" | "camelCase" | "PascalCase" | "MIXED"
- `folder_naming_convention`: "kebab-case" | "camelCase" | "PascalCase" | "MIXED"
- `deepest_file_depth`: integer
- `files_at_excessive_depth`: integer (depth 6+)

Example:
{"entry_type":"folder_structure","kind":"domain-concept","name":"users","file_path":"src/users","line_number":1,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","depth":1,"ts_file_count":5,"naming_convention":"kebab-case","is_flagged":false,"flag_reason":null}

After all entries:
{"_summary":true,"entry_type":"folder_structure","total_count":N,"flagged_count":0,"catch_all_count":0,"structural_anchor_violations":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
