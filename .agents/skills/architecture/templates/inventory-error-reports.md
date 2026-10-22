# Inventory — Error Reports

You are cataloging every error reporting call in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Error reports are calls that send exception data to an external monitoring service (Sentry, Datadog, Bugsnag, Rollbar). This inventory answers: where does the codebase report errors, and do those reports include enough context to diagnose the failure from the dashboard alone?

Find ALL of these:
- `Sentry.captureException(...)`, `Sentry.captureMessage(...)`
- `Sentry.withScope(...)`, `Sentry.setContext(...)`, `Sentry.setExtra(...)`
- `datadogLogs.logger.error(...)`, `dd.tracer.captureError(...)`
- `bugsnag.notify(...)`, `Rollbar.error(...)`
- Custom wrappers (`reportError(...)`, `captureError(...)`, `notifyError(...)`)

---

## Step 1 — Find Sentry Calls

```bash
grep -rn "Sentry\.\|captureException\|captureMessage\|withScope\|setContext\|setExtra\|setTag\|addBreadcrumb" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

---

## Step 2 — Find Other Error Monitoring Calls

```bash
grep -rn "bugsnag\.\|Rollbar\.\|trackError\|reportError\|captureError\|notifyError" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
grep -rn "from '@sentry\|from 'bugsnag\|from '@bugsnag\|from 'rollbar\|from '@rollbar" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | head -10
```

---

## Step 3 — Assess Context Completeness

For each error report call, read 5 lines of context:
- Does it pass the error object directly?
- Does it set user context (userId, session) before capturing?
- Does it add relevant input data (entity IDs, request params)?
- Is it inside a catch block, or reporting a non-exception event?

```bash
grep -rn "setUser\|setContext\|setExtra\|setTag" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -15
```

---

## Step 4 — Write the Inventory

Write one JSONL line per error report site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "error_reports"
- `kind`: "EXCEPTION_CAPTURE" | "MESSAGE_CAPTURE" | "BREADCRUMB" | "CONTEXT_SET" | "CUSTOM"
- `name`: method called (e.g., "Sentry.captureException")
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `monitoring_lib`: string (e.g., "sentry", "bugsnag", "rollbar", "datadog")
- `passes_error_object`: boolean
- `has_user_context`: boolean (sets user/session info before capture)
- `has_extra_context`: boolean (sets additional key-value context)
- `in_catch_block`: boolean

Example:
{"entry_type":"error_reports","kind":"EXCEPTION_CAPTURE","name":"Sentry.captureException","file_path":"src/services/billing.ts","line_number":134,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","monitoring_lib":"sentry","passes_error_object":true,"has_user_context":false,"has_extra_context":true,"in_catch_block":true}

After all entries:
{"_summary":true,"entry_type":"error_reports","total_count":N,"by_kind":{"EXCEPTION_CAPTURE":0,"MESSAGE_CAPTURE":0,"BREADCRUMB":0,"CONTEXT_SET":0,"CUSTOM":0},"with_user_context":0,"without_user_context":0,"in_catch_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
