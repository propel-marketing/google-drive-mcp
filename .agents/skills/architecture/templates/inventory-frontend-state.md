# Inventory — Frontend State

You are cataloging every state management mechanism in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every frontend state mechanism: global stores (Zustand, Redux, Jotai, Recoil), React Context providers, server-state caches (React Query, SWR, RTK Query), and local-state hotspots (components with heavy `useState` usage). State management shapes are architectural decisions — knowing what exists prevents duplication and drift.

Read `{{CODEBASE_PATH}}/package.json` first to identify which state libraries are present.

---

## Step 1 — Find Global Stores

```bash
grep -rEn 'create\(|createStore|atom\(|createSlice|configureStore' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

Also check for Zustand specifically:
```bash
grep -rEn "from 'zustand'\|from \"zustand\"" {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules
```

---

## Step 2 — Find Context Providers

```bash
grep -rEn 'createContext|\.Provider' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

---

## Step 3 — Find Server-State Caches

```bash
grep -rEn 'useQuery\(|useMutation\(|useSWR\(|useInfiniteQuery\(' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

---

## Step 4 — Find Local-State Hotspots

Components using `useState` 5+ times are candidates for extracting to a store or hook:

```bash
grep -rEn 'useState\(' {{CODEBASE_PATH}}/src --include='*.tsx' --include='*.jsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.' | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head -20
```

List the top 10 files by `useState` count.

---

## Step 5 — Write the Inventory

Write one JSONL line per state mechanism to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `entry_type`: "frontend_state"
- `name`: store/context name or file identifier (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `kind`: "global_store" | "context_provider" | "server_cache" | "local_state_hotspot"
- `library`: "zustand" | "redux" | "jotai" | "recoil" | "react_query" | "swr" | "context_api" | "none" | "unknown"
- `consumer_count`: integer (files that import this store/context)
- `is_typed`: boolean (state shape has a TypeScript type)
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
```json
{"entry_type":"frontend_state","name":"useAuthStore","file_path":"src/store/auth.ts","line_number":5,"kind":"global_store","library":"zustand","consumer_count":8,"is_typed":true,"is_test_file":false,"confidence":"parsed"}
```

After all entries, write the summary:
```json
{"_summary":true,"entry_type":"frontend_state","total_count":N,"global_stores":0,"context_providers":0,"server_caches":0,"local_state_hotspots":0,"untyped_count":0,"status":"complete"}
```

If no state mechanisms found:
```json
{"_summary":true,"entry_type":"frontend_state","total_count":0,"status":"empty"}
```

---

Status: COMPLETE
