# Inventory — Frontend Components

You are cataloging every UI component in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every React/Vue/Svelte/Solid component — function components, class components, single-file components. This is the primary UI building block inventory. Capture enough metadata that downstream diagnostics (size, dead-components, prop-drilling) can apply their principles without re-reading source.

Read `{{CODEBASE_PATH}}/package.json` first to detect the actual framework. Adapt detection patterns if the codebase doesn't use React/TSX.

---

## Step 1 — Find Function Components

```bash
grep -rEn '^(export )?(default )?function [A-Z]' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

Also check for arrow-function components assigned to capitalized names:

```bash
grep -rEn '^(export )?(const|let) [A-Z][A-Za-z]+ = (\(|React\.memo|memo\()' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

---

## Step 2 — Detect Server vs Client Components

For Next.js / React Server Components codebases:

```bash
grep -rln '"use client"\|'"'"'use client'"'" {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules
```

```bash
grep -rln '"use server"\|'"'"'use server'"'" {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules
```

Files with neither directive in a Next.js 13+ app are server components by default. Note this in each record.

---

## Step 3 — Check Props Typing

For each component found, check whether its props are typed (TypeScript interface, type alias, or inline type):

```bash
grep -n "Props\|FC<\|FunctionComponent<\|React\.FC" {{FILE}} 2>/dev/null | head -5
```

---

## Step 4 — Check Import Coverage (dead component detection)

For each component, check whether it is imported anywhere:

```bash
grep -rn "from.*{{COMPONENT_FILE_RELATIVE}}\|import.*{{COMPONENT_NAME}}" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -v "{{COMPONENT_FILE_RELATIVE}}" | wc -l
```

Record `importer_count` in each record.

---

## Step 5 — Measure Size

For each component file:

```bash
wc -l < {{FILE}}
```

Record `size_loc`.

---

## Step 6 — Write the Inventory

Write one JSONL line per component to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `entry_type`: "frontend_components"
- `name`: component name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer (line of declaration)
- `kind`: "function" | "arrow_function" | "class" | "memo_wrapped"
- `is_server_component`: boolean (true if no "use client" directive in Next.js app)
- `is_client_component`: boolean (has "use client")
- `props_typed`: boolean
- `size_loc`: integer
- `importer_count`: integer (0 = potentially dead)
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
```json
{"entry_type":"frontend_components","name":"UserCard","file_path":"src/components/UserCard.tsx","line_number":12,"kind":"function","is_server_component":false,"is_client_component":true,"props_typed":true,"size_loc":87,"importer_count":4,"is_test_file":false,"confidence":"parsed"}
```

After all entries, write the summary:
```json
{"_summary":true,"entry_type":"frontend_components","total_count":N,"server_components":0,"client_components":0,"untyped_props":0,"dead_candidates":0,"oversized_count":0,"status":"complete"}
```

If no components found after exhaustive search, write:
```json
{"_summary":true,"entry_type":"frontend_components","total_count":0,"status":"empty"}
```

---

Status: COMPLETE
