# Inventory — Classes

You are cataloging every class in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

A class is the owner of behavior that operates on a named concept. Find ALL of these:

1. **Standard classes** — `class UserService { ... }`
2. **Abstract classes** — `abstract class BaseRepository<T> { ... }`
3. **Classes with private state** — classes that hold instance variables
4. **Error classes** — `class NotFoundError extends Error { ... }`
5. **Singleton-pattern classes** — always instantiated once, or static classes
6. **Classes masquerading as namespaces** — only static methods, no instance state

---

## Phase 1 — Discover Class Files

Run the following grep to get the list of files containing at least one class declaration. Returns file paths only — do not read files yet.

```bash
grep -rln "^export class \|^class \|^export abstract class \|^abstract class " {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" \
  | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sort
```

Also build these lookup sets now — stored in memory, not re-run per file:

**Error classes** (file:line pairs):
```bash
grep -rn "extends Error\b\|extends.*Error\b" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

**Implements relationships** (file:line pairs):
```bash
grep -rn "implements [A-Z]" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

**Instantiation sites** — count of `new ClassName(` across the entire codebase. Run once now:
```bash
grep -rn "new [A-Z][A-Za-z]*(" {{CODEBASE_PATH}}/src \
  --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" \
  | sed 's/.*new //' | sed 's/(.*//' | sort | uniq -c | sort -rn
```

Store the output as a name→count map. You will look up each class name here during Phase 2.

Record the total file count. This is your lap count basis.

---

## Phase 2 — Lap Swimmer: Process Files in Batches

Process the file list in batches of **5 files per lap**. For each lap:

**Read each file completely.** Do not use grep -A snippets. Read the full file. This gives you complete import context, constructor bodies, instance variable declarations, and accurate method counts regardless of class size.

For each file, extract every class declaration:

1. **Identify all class blocks** — find every `class` or `abstract class` keyword and read to its closing `}` at column 0. A file may contain multiple classes — record each separately.

2. **Determine kind**:
   - `abstract class` → ABSTRACT
   - `extends Error` (from Phase 1 error lookup) → ERROR
   - Only static methods, zero instance variables → STATIC_NAMESPACE
   - Single shared instance pattern (static `instance` field or module-level `export const x = new X()`) → SINGLETON
   - Otherwise → STANDARD

3. **Count accurately from the body**:
   - `method_count`: non-constructor non-static public method signatures
   - `private_field_count`: `private` or `#` instance variable declarations
   - `constructor_param_count`: parameters in the constructor signature

4. **Determine cohesion** — scan all method names. Do they cluster around one concept (HIGH) or span unrelated concerns (LOW)? If only 1–2 methods or unclear, use UNKNOWN.

5. **Determine layer from imports** — read the import block at top of file. React/Next.js/UI libs → frontend. DB/ORM/infra libs → infrastructure. Both → shared. Neither → backend. Path alone is a fallback.

6. **Look up implements and instantiation count** — consult Phase 1 lookup sets. Do not re-grep.

7. **Write JSONL entries immediately** — after processing each file, append entries to `{{OUTPUT_PATH}}` in append mode. Do not batch writes across laps.

**After each lap, write a checkpoint to stdout:**
```
Classes lap {N}/{TOTAL_LAPS} complete — processed files {START}–{END} of {TOTAL_FILES}, wrote {N_ENTRIES} entries
```

---

## JSONL Schema

One line per class declaration. Every line must be valid JSON.

Required fields:
- `entry_type`: "classes"
- `kind`: "STANDARD" | "ABSTRACT" | "ERROR" | "SINGLETON" | "STATIC_NAMESPACE"
- `name`: string — class name exactly as declared
- `file_path`: path relative to codebase root
- `line_number`: integer — line of the `class` keyword
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "ai_judged"
- `implements_interface`: string | null — interface name if `implements`, else null
- `extends_class`: string | null — parent class name if `extends` (non-Error), else null
- `instantiation_count`: integer — from Phase 1 name→count map, 0 if not found
- `method_count`: integer
- `private_field_count`: integer
- `constructor_param_count`: integer
- `cohesion`: "HIGH" | "LOW" | "UNKNOWN"

Example:
```
{"entry_type":"classes","kind":"STANDARD","name":"UserService","file_path":"src/users/user-service.ts","line_number":5,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","implements_interface":"IUserService","extends_class":null,"instantiation_count":1,"method_count":4,"private_field_count":2,"constructor_param_count":1,"cohesion":"HIGH"}
```

---

## Phase 3 — Summary

After all laps complete, append the summary line:

```
{"_summary":true,"entry_type":"classes","total_count":N,"by_kind":{"STANDARD":0,"ABSTRACT":0,"ERROR":0,"SINGLETON":0,"STATIC_NAMESPACE":0},"without_interface":0,"low_cohesion_count":0,"files_processed":0,"status":"complete"}
```

Append as final line:
`Status: COMPLETE`
