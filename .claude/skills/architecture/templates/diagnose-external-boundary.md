# Diagnose — External Boundary

You are auditing whether outbound calls to external APIs in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}` are schema-validated on response, handle typed failure modes (not just status codes), and use typed constants for rate limits and credentials — rather than magic numbers and inline strings.

This diagnostic is discovery-driven via grep. No inventory file input required.

Write all findings to: `{{OUTPUT_PATH}}` (extension `.jsonl`)

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What This Diagnostic Proves

Every outbound call to an external API is a boundary. When your code calls a third-party service, the response re-enters the system as untrusted input — identical in risk to user-submitted form data. The same schema discipline that applies to HTTP request bodies must apply to HTTP response bodies.

Three things must hold:
- Every response is parsed through a schema before the data enters your type system
- Every failure mode is handled with specificity (not just `catch (e) { throw e }` or `if (!ok) throw new Error("failed")`)
- Rate limits, credential identifiers, and API base URLs are typed constants, not magic strings scattered across call sites

A call site that destructures a response without validation is an unguarded boundary: a runtime type error (or worse, a security incident) waiting for the external API to change its contract.

---

## Phase 0 — Discovery (probe, do not assume)

Do not assume any specific SDK, pattern, or client structure. Run each probe, record what was found, and carry the results into Phase 1.

### Probe A — Credential environment variables

Credentials are the clearest signal that an external API relationship exists. They identify which external services the codebase depends on.

```bash
grep -rn "process\.env\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -iE "KEY|SECRET|TOKEN|API|CLIENT|PASS|CREDENTIAL" | grep -v "//.*process\.env" | sed 's/.*process\.env\.\([A-Z_]*\).*/\1/' | sort -u | head -30
```

```bash
grep -rn "process\.env\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -iE "URL|ENDPOINT|HOST|BASE" | sed 's/.*process\.env\.\([A-Z_]*\).*/\1/' | sort -u | head -20
```

**Result A:** List of credential/URL env vars found, or `NOT_FOUND`

---

### Probe B — Known SDK imports

SDK imports are the richest signal: they tell you which external services the codebase uses, and SDKs often provide built-in types. When an SDK is present, the call sites are findable by import.

```bash
grep -rn "from '@anthropic-ai\|from 'openai\|from '@google\|from 'stripe\|from '@stripe\|from 'twilio\|from 'sendgrid\|from '@sendgrid\|from 'resend\|from '@resend\|from 'datadog\|from '@datadog\|from '@upstash\|from 'ioredis\|from '@aws-sdk\|from 'aws-sdk\|from 'firebase\|from '@firebase\|from 'supabase\|from '@supabase\|from 'clerk\|from '@clerk\|from 'inngest\|from 'trigger\|from 'posthog\|from '@posthog\|from 'mixpanel\|from 'amplitude\|from '@segment'" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sed "s/.*from '\\([^']*\\)'.*/\\1/" | sort -u | head -30
```

```bash
grep -rn "from '@" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "from '@/\|from '@tanstack\|from '@radix\|from '@hookform\|from '@dnd" | sed "s/.*from '\\([^']*\\)'.*/\\1/" | sort -u | head -20
```

**Result B:** `SDKS_FOUND` (list of SDK package names) | `NOT_FOUND`

---

### Probe C — Raw fetch to external URLs

Some codebases call external APIs with raw `fetch()` rather than an SDK. These are the highest-risk call sites because there are no built-in types.

```bash
grep -rn "fetch(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -E "https?://|process\.env\." | grep -v "//.*fetch(" | head -30
```

```bash
grep -rn "fetch(\`\|fetch('" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

```bash
grep -rn "axios\|got\|ky\|superagent\|node-fetch\|cross-fetch\|undici" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -10
```

**Result C:** `RAW_FETCH_FOUND` (list of files with raw fetch calls) | `HTTP_CLIENT` (library name) | `NOT_FOUND`

---

### Probe D — Response schema coverage

Schema-validated responses are the safest call sites. Find them to establish baseline coverage before looking for gaps.

```bash
grep -rn "\.safeParse\|\.parse(\|z\.object\|z\.array\|z\.string\|z\.number" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -iv "request\|body\|params\|query\|payload\|job\|phase" | head -30
```

```bash
find {{CODEBASE_PATH}}/src -name "*.schema.ts" -o -name "schemas.ts" | grep -v node_modules | grep -v ".next" | grep -iv "job\|phase\|queue\|workflow\|task\|request\|body"
```

```bash
grep -rn "ResponseSchema\|ApiResponseSchema\|ExternalSchema\|.*Response.*Schema\|.*Schema.*Response" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

**Result D:** `RESPONSE_SCHEMAS_FOUND` (list of schema names and files) | `NOT_FOUND`

---

### Probe E — Service/client wrapper files

Centralised service files are the best practice: external calls isolated behind a typed client. Find them.

```bash
find {{CODEBASE_PATH}}/src -type d -name "services" -o -name "clients" -o -name "integrations" -o -name "api" | grep -v node_modules | grep -v ".next" | grep -v "app/api\|server/api\|routes"
```

```bash
find {{CODEBASE_PATH}}/src -type f -name "client.ts" -o -name "*Client.ts" -o -name "*Service.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

**Result E:** `SERVICE_FILES_FOUND` (list of client/service files) | `NOT_FOUND`

---

## Phase 1 — Route

Read your Discovery results. Select the detection path.

| Discovery result | Detection path |
|---|---|
| Result B = `SDKS_FOUND` + Result E = `SERVICE_FILES_FOUND` | **Path 1 — SDK + service layer** (most structured) |
| Result B = `SDKS_FOUND` + Result E = `NOT_FOUND` | **Path 2 — SDK without service layer** |
| Result C = `RAW_FETCH_FOUND` + Result E = `SERVICE_FILES_FOUND` | **Path 3 — Raw fetch with service layer** |
| Result C = `RAW_FETCH_FOUND` + Result E = `NOT_FOUND` | **Path 4 — Raw fetch scattered** (highest risk) |
| Result C = `HTTP_CLIENT` | **Path 5 — HTTP client library** |
| Result A != `NOT_FOUND` + Result B = `NOT_FOUND` + Result C = `NOT_FOUND` | **Path 6 — Credentials without call sites** |
| All probes `NOT_FOUND` | **Path 7 — No external calls detected** |

Record which path was selected and why. Note: paths are not mutually exclusive — if both SDKs and raw fetch are found, run Path 1/2 AND Path 3/4.

---

## Phase 2 — Detect

### Path 1 — SDK + service layer

SDKs provide built-in types, but responses are often wider than needed. The service layer should narrow them through schema validation.

**Step 1.1** — Read each service file from Result E. For each file:
- What SDK(s) does it import?
- What methods does it export?
- For each method that calls the SDK, is the response passed through a Zod schema or similar before being returned?

```bash
grep -rn "\.parse(\|\.safeParse(\|z\.infer\|ZodSchema" {service_file} 2>/dev/null | head -20
```

**Step 1.2** — For each SDK call, check the response handling:
- Does it call `.parse()` or `.safeParse()` on the response? → **SCHEMA_VALIDATED**
- Does it rely on the SDK's own TypeScript types without further validation? → **SDK_TYPED** (acceptable if SDK types are strict, flag as MINOR if the response contains `any`)
- Does it destructure or access properties directly from the raw response? → **UNVALIDATED** (MAJOR)

**Step 1.3** — Locate credential usage:
```bash
grep -rn "process\.env\." {service_file} | head -20
```
- Credentials accessed via a typed config object or exported constant: **TYPED_CONFIG**
- Credentials inlined as `process.env.FOO` directly in the call: **INLINE_CREDENTIAL** (MINOR — violates centralization, but not a type gap)
- API base URLs hardcoded as string literals: **MAGIC_URL** (MINOR)

**Step 1.4** — Locate error handling:
```bash
grep -rn "catch\|\.error\|status.*!==\|!ok\|statusCode" {service_file} | head -20
```
- Error handler reads specific error fields from the response body and produces a typed error or typed return value: **TYPED_ERROR**
- Error handler catches and rethrows without reading the response body: **OPAQUE_ERROR** (MAJOR)
- No error handling: **UNHANDLED** (CRITICAL)

**Step 1.5** — Rate limit handling:
```bash
grep -rn "rateLimit\|rate_limit\|429\|retryAfter\|retry-after\|Retry-After\|delay\|sleep\|backoff" {service_file} | head -10
```
- Rate limits are named constants imported from a config file: **TYPED_RATE_LIMIT**
- Rate limits are magic numbers (`await sleep(1000)`, `if (status === 429)`): **MAGIC_RATE_LIMIT** (MINOR)
- No rate limit handling despite API docs specifying limits: **UNHANDLED_RATE_LIMIT** (MAJOR — flag only when API is known to have rate limits)

---

### Path 2 — SDK without service layer

SDK calls are scattered across route handlers, utility functions, or component server actions — no centralized client.

**Step 2.1** — Find all SDK import sites using Result B:
```bash
grep -rn "from '{sdk_package}'" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Step 2.2** — For each import site, read the file. Apply the same checks as Path 1 (schema, error handling, credentials, rate limits).

**Step 2.3** — Note as MAJOR: no service layer means SDK calls are not centralized. If the external API changes its contract, every call site must be updated. Flag: "SDK calls for {service} are not isolated behind a service layer — contract changes require updating N files."

**Step 2.4** — Check for duplicated SDK initialization:
```bash
grep -rn "new Anthropic\|new OpenAI\|new Stripe\|new Resend\|new Twilio" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```
Multiple initialization sites: **DUPLICATED_CLIENT** (MINOR — each initialization consumes resources and credentials; centralize into a singleton).

---

### Path 3 — Raw fetch with service layer

Raw fetch behind a service layer is structured but high-risk: the response type is `Response`, and without a schema the data is `any`.

**Step 3.1** — Read each service file that contains raw fetch calls. For each call:
- What URL does it call? (hardcoded, env var, or interpolated?)
- What does it do with the response?

```bash
grep -rn "fetch(" {service_file} | head -20
```

**Step 3.2** — Trace the response through the function. Look for the pattern:
```
const res = await fetch(...)
const data = await res.json()
// what happens to data next?
```
- `Schema.parse(data)` or `Schema.safeParse(data)`: → **SCHEMA_VALIDATED**
- `data as MyType` or explicit cast: → **CAST_ONLY** (CRITICAL — cast without validation is an unguarded boundary)
- Property access `data.foo.bar` without validation: → **RAW_ACCESS** (CRITICAL)
- Returned directly: → **UNVALIDATED_PASSTHROUGH** (CRITICAL)

**Step 3.3** — Check response status handling before `res.json()`:
- `if (!res.ok) throw new Error(...)` with status code: **BASIC_ERROR** (acceptable minimum)
- Reads error body with schema: **TYPED_ERROR**
- No status check before `.json()`: **NO_STATUS_CHECK** (MAJOR)

**Step 3.4** — Apply credential and rate limit checks from Path 1, steps 1.3–1.5.

---

### Path 4 — Raw fetch scattered

Raw fetch is used directly in route handlers, utility files, or inline in business logic — no service layer to centralize the risk.

**Step 4.1** — List all raw fetch call sites from Result C:
```bash
grep -rn "fetch(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -E "https?://|process\.env\." | grep -v "//.*fetch("
```

**Step 4.2** — For each file containing a raw fetch call, read the function that contains it. Apply the response tracing checks from Path 3, Step 3.2.

**Step 4.3** — Note as MAJOR: raw fetch calls not behind a service layer. Scattered raw fetch means response schema coverage is untrackable — there is no single place to audit all external calls.

**Step 4.4** — Flag CRITICAL for each unvalidated raw fetch response found. Prioritize by: (1) calls that access user-controlled external services, (2) calls that write returned data to the database, (3) calls that return data to the client.

---

### Path 5 — HTTP client library

A library like `axios`, `got`, or `ky` provides response interception but not response types.

**Step 5.1** — Find the client initialization:
```bash
grep -rn "axios\.create\|got\.extend\|ky\.create\|new Got\|createGot" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -10
```

**Step 5.2** — Check for global response interceptors that apply schema validation:
```bash
grep -rn "interceptors\|transformResponse\|afterResponse\|hooks" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -10
```
- Global interceptor with schema parse: **INTERCEPTOR_VALIDATED**
- No global interceptor: proceed to per-call checks

**Step 5.3** — Apply per-call checks using the same method as Path 3, Step 3.2.

---

### Path 6 — Credentials without call sites

Env vars that look like API credentials exist, but no SDK imports or fetch calls were found. This is either dead configuration or obfuscated call sites.

**Step 6.1** — For each credential env var from Result A, grep for its usage:
```bash
grep -rn "process\.env\.{VAR_NAME}" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

**Step 6.2** — If the credential is used only in a config object (never passed directly to a call site), trace the config object to find where it's consumed.

**Step 6.3** — If the credential is unused: flag as INFO — credential defined but no call site found, may be dead configuration or only used in a runtime context not visible to static analysis.

**Step 6.4** — If the credential flows into a dynamic import or subprocess call that can't be traced statically: flag as MAJOR — credential usage is not grep-constructible.

---

### Path 7 — No external calls detected

All probes returned NOT_FOUND.

**Step 7.1** — Verify the negative: read `package.json` for any HTTP client, external API, or SDK dependency not caught by the grep patterns:
```bash
cat {{CODEBASE_PATH}}/package.json | grep -E '"dependencies"' -A 200 | grep -iE "api|sdk|client|http|fetch|axios|got|ky|request" | head -20
```

**Step 7.2** — If genuinely absent: write one INFO finding: "No external API calls detected — diagnostic not applicable." Status: COMPLETE.

**Step 7.3** — If dependencies exist but call sites were not found: flag as MAJOR — "External API dependency present (package: {name}) but call sites not locatable by search — external boundary is invisible to static analysis."

---

## Phase 3 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `category`: "external_boundary"
- `diagnostic_type`: "external_boundary"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description including the external service name when known
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Severity guide:
- **CRITICAL**: response accessed without schema validation (raw destructuring, cast-only, unvalidated passthrough), no error handling at a call site that writes to the database or returns to the client
- **MAJOR**: response partially validated (status check but no body schema), no service layer for external calls, scattered raw fetch, credential usage not grep-constructible, external call swallowed in a catch block with no typed error
- **MINOR**: credentials inlined as process.env rather than a typed config object, magic-number rate limits, duplicated SDK client initialization, schema defined inline at call site rather than in a central schemas file
- **INFO**: detection path taken, list of external services identified, services with full schema coverage (positive finding)

Summary record (last line before Status):
```json
{"_summary":true,"diagnostic_type":"external_boundary","detection_path":"Path N","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"external_services_found":N,"call_sites_found":N,"schema_validated":N,"unvalidated":N,"typed_error_handling":N,"opaque_error_handling":N,"status":"complete"}
```

---

Append as final line:
`Status: COMPLETE`
