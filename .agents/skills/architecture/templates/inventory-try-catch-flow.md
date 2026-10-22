# Inventory — Try/Catch Flow

You are cataloging every try/catch block in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every `catch` block is a decision about what to do when something fails. The quality of that decision determines whether failures are recoverable, logged with enough context, or silently swallowed.

Find and classify ALL try/catch blocks:
1. **FULL_CONTEXT** — logs class, method, inputs, error.message, and stack; returns typed failure result
2. **PARTIAL** — catches and logs something but missing key fields
3. **SWALLOWED** — catches and does not log or rethrow; failure disappears
4. **RE_THROWN** — catches and rethrows without adding context
5. **CONVERTED** — catches and converts to a typed error result (`{ success: false, error: ErrorClass }`)

---

## Step 1 — Find All Catch Blocks

```bash
grep -rn "} catch\|catch (" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each catch block, read 10 lines of context to understand:
- What error variable is named (e.g., `err`, `error`, `e`, `_`)
- What happens in the catch body

---

## Step 2 — Find Swallowed Catches

A swallowed catch either has an empty body or only comments:

```bash
grep -rn "catch.*{$\|catch.*{\s*}\|catch.*{\s*\/\/" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
grep -rn "catch (_\|catch (e)" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

For each: read the catch body. Empty body or only `// ignore` = SWALLOWED.

---

## Step 3 — Find Context Quality in Non-Swallowed Catches

For catches that DO log, check what context is included:

```bash
grep -rn "console\.error\|logger\.error\|log\.error" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

Look for catches that log `error.message` but not `error.stack`, or log the error but not the input that caused it.

---

## Step 4 — Write the Inventory

Write one JSONL line per catch block to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "try_catch_flow"
- `kind`: "FULL_CONTEXT" | "PARTIAL" | "SWALLOWED" | "RE_THROWN" | "CONVERTED"
- `name`: enclosing function or method name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer (line of the `catch` keyword)
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `logs_error`: boolean
- `logs_stack`: boolean
- `logs_inputs`: boolean
- `rethrows`: boolean
- `converts_to_typed`: boolean

Example:
{"entry_type":"try_catch_flow","kind":"SWALLOWED","name":"fetchUserData","file_path":"src/services/user.ts","line_number":45,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"ai_judged","logs_error":false,"logs_stack":false,"logs_inputs":false,"rethrows":false,"converts_to_typed":false}

After all entries:
{"_summary":true,"entry_type":"try_catch_flow","total_count":N,"by_kind":{"FULL_CONTEXT":0,"PARTIAL":0,"SWALLOWED":0,"RE_THROWN":0,"CONVERTED":0},"swallowed_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
