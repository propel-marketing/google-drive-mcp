# Inventory — State Shapes

You are cataloging every client-side state shape in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

State shapes are types held in React state, context, or client-side stores (Zustand, Redux, Jotai).

| Find here | Find elsewhere |
|-----------|---------------|
| Zustand store state types | Server-side domain entities → inventory-domain-models |
| Redux slice state types | API response shapes → inventory-data-transfer-objects |
| React `useState<T>` type parameters | UI configuration types → inventory-config |
| Context value types | |
| Form field state types | |

---

## Step 1 — Find Store State Types

```bash
grep -rn "create<\|createSlice\|useReducer\|createContext\|zustand\|jotai\|atom(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each store: read its state type definition. Is it explicitly typed or inferred from an initializer?

---

## Step 2 — Find React State Types

```bash
grep -rn "useState<\|useRef<\|useContext<" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each explicit `useState<T>`: what is T? Is T a named domain type or an anonymous inline shape?

---

## Step 3 — Find Context Value Types

```bash
grep -rn "createContext<\|React\.createContext<" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each context: what type does it carry? Is it undefined-initialized (context without a default value is a common footgun)?

---

## Step 4 — Write the Inventory

Write one JSONL line per state shape to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "state_shapes"
- `kind`: "ZUSTAND_STORE" | "REDUX_SLICE" | "REACT_STATE" | "REACT_CONTEXT" | "JOTAI_ATOM" | "FORM_STATE"
- `name`: type or store name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `is_typed`: boolean (false if type is fully inferred from initializer)
- `is_server_synced`: boolean (true if this state mirrors server data — potential staleness risk)

Example:
{"entry_type":"state_shapes","kind":"ZUSTAND_STORE","name":"UserStore","file_path":"src/stores/user.ts","line_number":5,"layer":"frontend","is_exported":true,"is_test_file":false,"confidence":"parsed","is_typed":true,"is_server_synced":true}

After all entries:
{"_summary":true,"entry_type":"state_shapes","total_count":N,"by_kind":{"ZUSTAND_STORE":0,"REDUX_SLICE":0,"REACT_STATE":0,"REACT_CONTEXT":0,"JOTAI_ATOM":0,"FORM_STATE":0},"untyped_count":0,"server_synced_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
