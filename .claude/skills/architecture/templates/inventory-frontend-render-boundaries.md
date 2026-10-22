# Inventory — Frontend Render Boundaries

You are cataloging every render boundary declaration in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every explicit render boundary: `"use client"` / `"use server"` directives (Next.js App Router), `<Suspense>` boundaries, and `<ErrorBoundary>` components. These are architectural decisions that determine where code runs (server vs client), how loading states are managed, and how errors are contained. Missing or misplaced boundaries cause runtime failures and hydration errors.

Read `{{CODEBASE_PATH}}/package.json` first to determine if this is a Next.js 13+ App Router codebase. If not, adjust detection patterns to the actual framework.

---

## Step 1 — Find "use client" Directives

```bash
grep -rln '"use client"\|'"'"'use client'"'" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules
```

For each file found, record line number:
```bash
grep -n '"use client"\|'"'"'use client'"'" {{FILE}}
```

---

## Step 2 — Find "use server" Directives

```bash
grep -rln '"use server"\|'"'"'use server'"'" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules
```

---

## Step 3 — Find Suspense Boundaries

```bash
grep -rEn '<Suspense\b' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

For each, check whether a `fallback` prop is present:
```bash
grep -A2 '<Suspense' {{FILE}} | grep -c 'fallback'
```

---

## Step 4 — Find Error Boundaries

```bash
grep -rEn '<ErrorBoundary\b|ErrorBoundary\b' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' --include='*.ts' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

Also check for class-based error boundary implementations:
```bash
grep -rEn 'componentDidCatch|getDerivedStateFromError' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.ts' 2>/dev/null | grep -v node_modules
```

---

## Step 5 — Identify Server Components Without Explicit Directive

In Next.js 13+ App Router, files in `app/` with no `"use client"` are server components by default. List them:

```bash
find {{CODEBASE_PATH}}/src/app {{CODEBASE_PATH}}/app 2>/dev/null -name "*.tsx" -o -name "*.jsx" | xargs grep -rLl '"use client"\|'"'"'use client'"'" 2>/dev/null | grep -v node_modules | head -30
```

---

## Step 6 — Write the Inventory

Write one JSONL line per boundary to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `entry_type`: "frontend_render_boundaries"
- `file_path`: path relative to codebase root
- `line_number`: integer
- `kind`: "use_client" | "use_server" | "suspense" | "error_boundary" | "implicit_server"
- `has_fallback`: boolean (for Suspense only — whether fallback prop is present)
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
```json
{"entry_type":"frontend_render_boundaries","file_path":"src/components/UserDashboard.tsx","line_number":1,"kind":"use_client","has_fallback":null,"is_test_file":false,"confidence":"parsed"}
```

After all entries, write the summary:
```json
{"_summary":true,"entry_type":"frontend_render_boundaries","total_count":N,"use_client":0,"use_server":0,"suspense_boundaries":0,"suspense_missing_fallback":0,"error_boundaries":0,"implicit_server_components":0,"status":"complete"}
```

If no boundaries found:
```json
{"_summary":true,"entry_type":"frontend_render_boundaries","total_count":0,"status":"empty"}
```

---

Status: COMPLETE
