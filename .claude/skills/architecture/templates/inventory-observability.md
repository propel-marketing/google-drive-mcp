# Inventory — Observability

You are auditing the observability of the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Observability is the system's ability to report its own state at runtime. A well-observable system answers four questions from its logs alone — without requiring a developer to read the source.

Find and assess ALL of these:

1. **Typed result returns** — do service functions return `OperationResult<T>` or equivalent typed result shapes, or do they throw naked exceptions?
2. **TrackingMessage** — does every response carry a user-readable `message` field? Do both success and failure paths include it?
3. **Boundary logging** — do service methods log at entry/exit with class name, method name, key input identifiers, outcome, and duration?
4. **Exception handler context** — when an error is caught, does the handler print full context (class, method, inputs, error.message, stack) or just `error.message`?
5. **Endpoint drillability** — for each backend route, can you answer four questions without leaving the file: what comes in, what comes out, what can fail, what does the user see?
6. **Local variable naming** — inside service and handler function bodies, do variables carry domain identity (`conversationRow`, `userSchema`) or generic names (`data`, `res`, `obj`, `result`, `response`, `item`, `temp`)?

---

## Step 1 — Find Service Function Return Patterns

Check whether service functions return typed results or throw:

```bash
grep -rn "return {" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "OperationResult\|{ success:\|{ error:\|\.success\b\|\.error\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "throw new\|throw err\|throw error" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each service function: does it return a typed `{ success: true, data: T, message: string }` / `{ success: false, error: string, message: string }` shape? Or does it throw? Or return `null`/`undefined` on failure?

---

## Step 2 — Find TrackingMessage / User-Facing Messages

```bash
grep -rn "TrackingMessage\|message:" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "// " | head -40
```

```bash
grep -rn "\"message\"\|'message'" {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | head -30
```

For each API response found in Step 1 routes: does it include a `message` field? Is the message written for the user (plain language, actionable) or for the developer (error codes, stack references)?

---

## Step 3 — Find Boundary Logging

```bash
grep -rn "console\.log\|console\.error\|console\.warn" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "console\.log\|console\.error" {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | head -30
```

For each `console.log` or `console.error` found: does it include the class name and method? Does it include key input identifiers (IDs, not full objects)? Does it include the outcome? On errors: does it include `error.message` AND `err.stack`?

---

## Step 4 — Find Exception Handlers

```bash
grep -rn "} catch\|catch (" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each catch block found, read the surrounding context. Classify:
- **FULL CONTEXT** — logs class, method, inputs, error.message, stack; returns typed failure result
- **PARTIAL** — logs something but missing key fields (stack, inputs, or class/method identifier)
- **SWALLOWED** — catches and does not log, or returns `null`/`undefined` silently
- **RE-THROWN** — catches and rethrows without adding context

---

## Step 5 — Endpoint Drillability Test

For each backend route handler found (from entry points inventory or Step 1's route grep):

```bash
grep -rn "export async function GET\|export async function POST\|export async function PUT\|export async function PATCH\|export async function DELETE" {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next"
```

Read each route handler file. Apply the four-question test — try to answer each question WITHOUT opening additional files:

1. **What comes in?** — Is the input schema defined in this file, or imported from elsewhere?
2. **What comes out?** — Is the response shape explicit in this file, or implicit?
3. **What can fail?** — Are error cases and status codes visible in this file?
4. **What does the user see?** — Are user-facing messages in this file?

Score each endpoint:
- **EXCELLENT** — all 4 answers in this file
- **GOOD** — 3 answers in this file, 1 requires opening 1 other file
- **POOR** — 2 answers in this file, must open 2–3 other files
- **BROKEN** — fewer than 2 answers in this file, 4+ files required

---

## Step 6 — Local Variable Naming Audit

Check for generic variable names inside function bodies in service and handler files:

```bash
grep -rn "\bconst data\b\|\bconst res\b\|\bconst obj\b\|\bconst temp\b\|\bconst item\b\|\bconst val\b\|\bconst value\b" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "\bconst data\b\|\bconst res\b\|\bconst result\b\|\bconst response\b" {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "\bconst data\b\|\bconst result\b\|\bconst response\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -60
```

For each match: read the surrounding 5 lines. What is the actual value assigned? What domain concept does it represent? What would an agent-readable name be?

---

## Step 7 — Write the Inventory

Write one JSONL line per observability site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "observability"
- `kind`: "RETURN_PATTERN" | "TRACKING_MESSAGE" | "LOG_CALL" | "EXCEPTION_HANDLER" | "DRILLABILITY" | "VARIABLE_NAMING"
- `name`: function or variable name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

For RETURN_PATTERN entries:
- `return_style`: "TYPED_RESULT" | "THROWS" | "NULL_ON_FAILURE" | "MIXED"
- `has_tracking_message`: boolean

For EXCEPTION_HANDLER entries:
- `handler_quality`: "FULL_CONTEXT" | "PARTIAL" | "SWALLOWED" | "RE_THROWN"
- `missing_fields`: array of strings (e.g., ["stack", "inputs"])

For DRILLABILITY entries:
- `method`: HTTP method string
- `drillability_score`: "EXCELLENT" | "GOOD" | "POOR" | "BROKEN"

For VARIABLE_NAMING entries:
- `generic_name`: the offending variable name (e.g., "data", "result")
- `suggested_name`: domain-specific alternative

Example:
{"entry_type":"observability","kind":"EXCEPTION_HANDLER","name":"catch in UserService.createUser","file_path":"src/users/user-service.ts","line_number":45,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"ai_judged","handler_quality":"SWALLOWED","missing_fields":["stack","inputs","class","method"]}

After all entries:
{"_summary":true,"entry_type":"observability","total_count":N,"by_kind":{"RETURN_PATTERN":0,"TRACKING_MESSAGE":0,"LOG_CALL":0,"EXCEPTION_HANDLER":0,"DRILLABILITY":0,"VARIABLE_NAMING":0},"swallowed_exceptions":0,"broken_drillability":0,"variable_naming_violations":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
