# Inventory — Log Calls

You are cataloging every logging call in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

A log call is the primary observability signal for production systems. This inventory answers: where does the codebase emit logs, and are those logs structured enough for an agent to diagnose a failure from log output alone?

Find ALL logging calls:
- `console.log`, `console.error`, `console.warn`, `console.info`, `console.debug`
- Structured loggers: `logger.info(...)`, `log.error(...)`, `winston.log(...)`, `pino.info(...)`

For each call: is the context sufficient to diagnose without reading the source?

---

## Step 1 — Find All Console Calls

```bash
grep -rn "console\.log\|console\.error\|console\.warn\|console\.info\|console\.debug" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

---

## Step 2 — Find Structured Logger Calls

```bash
grep -rn "logger\.\|log\.\|winston\.\|pino\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "\.info\|\.error\|\.warn\|\.debug" | head -40
```

---

## Step 3 — Classify Each Log Call

For each log call, read 3 lines of context and classify by context quality:

| Quality | Definition |
|---------|-----------|
| **FULL** | Includes class/function name, key input identifiers (IDs), outcome, and (for errors) stack |
| **PARTIAL** | Has some context but missing key fields |
| **BARE** | Logs only the error message, or a static string with no dynamic context |
| **SILENT** | Empty catch block or log with no useful information |

---

## Step 4 — Write the Inventory

Write one JSONL line per log call to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "log_calls"
- `kind`: "CONSOLE" | "STRUCTURED" | "CUSTOM"
- `name`: log method called (e.g., "console.error", "logger.info")
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `level`: "error" | "warn" | "info" | "debug" | "log"
- `context_quality`: "FULL" | "PARTIAL" | "BARE"
- `includes_error_object`: boolean
- `includes_stack`: boolean
- `in_catch_block`: boolean

Example:
{"entry_type":"log_calls","kind":"CONSOLE","name":"console.error","file_path":"src/services/billing.ts","line_number":89,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","level":"error","context_quality":"BARE","includes_error_object":true,"includes_stack":false,"in_catch_block":true}

After all entries:
{"_summary":true,"entry_type":"log_calls","total_count":N,"by_level":{"error":0,"warn":0,"info":0,"debug":0,"log":0},"by_quality":{"FULL":0,"PARTIAL":0,"BARE":0},"in_catch_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
