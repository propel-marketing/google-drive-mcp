# Inventory — Entry Points

You are cataloging every place untrusted data enters the system in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

An entry point is any place where data crosses from outside the system into trusted code. This includes:

**Backend**
- HTTP route handlers (GET, POST, PUT, PATCH, DELETE, OPTIONS)
- Webhook receivers
- Background job handlers / queue consumers
- Server actions (Next.js `action=` functions)
- Cron handlers

**Frontend**
- Form submit handlers
- Client-side API call sites (fetch, axios, trpc, etc.)
- URL/query param parsing
- localStorage / sessionStorage reads
- PostMessage handlers

**Database**
- Raw query result consumption (the point where a DB row becomes application data)
- ORM model instantiation
- JSON/JSONB column reads where the structure is not guaranteed by the schema

**External**
- External API response parsing
- File reads (JSON, CSV, config files)
- Environment variable access

For each entry point, the question is: **is there a schema between the outside world and the code that trusts the data?**

---

## Step 1 — Find Backend Entry Points

```bash
grep -rn "export async function GET\|export async function POST\|export async function PUT\|export async function PATCH\|export async function DELETE" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "req\.body\|req\.json\|req\.params\|req\.query\|request\.json\|formData()" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "'use server'\|\"use server\"" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each result, read the surrounding code to understand what data enters and whether it is validated before use.

---

## Step 2 — Find Frontend Entry Points

```bash
grep -rn "onChange\|onSubmit\|handleSubmit\|useSearchParams\|useParams\|localStorage\.getItem\|searchParams\.get" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "fetch(\|axios\.\|useQuery\|useMutation\|trpc\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each frontend entry point, note: what data is consumed? What is the type at the point of consumption? Is it typed or inferred as `any`?

---

## Step 3 — Find Database Entry Points

```bash
grep -rn "\.query\|\.select\|\.findFirst\|\.findMany\|\.execute\|db\.\|sql\`" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
grep -rn "jsonb\|json_build\|JSON\.parse\|\.payload\b\|\.data\b" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each database result consumption point: what type does the result carry? Is there a `.$type<>()` annotation on jsonb columns? Are raw rows immediately typed or passed as generic objects?

---

## Step 4 — Find External API Entry Points

```bash
grep -rn "\.json()\|JSON\.parse\|response\.data\|res\.data" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each: is there a `.parse()` or `.safeParse()` call immediately after? Or does the raw response flow directly into the application?

---

## Step 5 — Find Schema Usage at Entry Points

```bash
grep -rn "\.parse(\|\.safeParse(\|z\.object\|z\.string\|z\.enum\|zod" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Cross-reference: which entry points from Steps 1–4 have a corresponding `.parse()` call in the same file and function? Which do not?

---

## Step 6 — Drillability Test (backend routes only)

For each backend route handler found in Step 1, read the route file and apply the four-question test — try to answer each question WITHOUT opening additional files:

1. **What comes in?** — Is the input schema defined in this file? Or imported from elsewhere?
2. **What comes out?** — Is the response shape explicit here (typed return, inline schema)? Or implicit?
3. **What can fail?** — Are error cases and their HTTP status codes visible in this file?
4. **What does the user see?** — Are user-facing messages written in this file? Or does the route delegate to the service and pass through opaque error strings?

Score each route:
- **EXCELLENT** — all 4 questions answered from this file alone
- **GOOD** — 3 answers here, 1 requires opening 1 other file
- **POOR** — 2 answers here, must open 2–3 other files
- **BROKEN** — fewer than 2 answers here; 4+ files required

---

## Step 7 — Write the Inventory

Write one JSONL line per entry point to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "entry_points"
- `kind`: "BACKEND_ROUTE" | "FRONTEND_FORM" | "FRONTEND_API_CALL" | "DATABASE_RESULT" | "EXTERNAL_API" | "SERVER_ACTION" | "WEBHOOK" | "OTHER"
- `name`: route path or description (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `method`: HTTP method string or null for non-HTTP entry points
- `schema_present`: boolean
- `schema_called_at_entry`: boolean
- `drillability_score`: "EXCELLENT" | "GOOD" | "POOR" | "BROKEN" | null (null for non-route entry points)

Example:
{"entry_type":"entry_points","kind":"BACKEND_ROUTE","name":"POST /api/users","file_path":"src/app/api/users/route.ts","line_number":12,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","method":"POST","schema_present":true,"schema_called_at_entry":true,"drillability_score":"GOOD"}

After all entries:
{"_summary":true,"entry_type":"entry_points","total_count":N,"by_kind":{"BACKEND_ROUTE":0,"FRONTEND_FORM":0,"FRONTEND_API_CALL":0,"DATABASE_RESULT":0,"EXTERNAL_API":0,"SERVER_ACTION":0,"WEBHOOK":0,"OTHER":0},"unguarded_count":0,"drillability":{"EXCELLENT":0,"GOOD":0,"POOR":0,"BROKEN":0},"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
