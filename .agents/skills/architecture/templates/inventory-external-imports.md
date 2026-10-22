# Inventory — External Imports

You are cataloging every external dependency imported in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

External imports are the surface area where the codebase touches the outside world — npm packages, node built-ins, cloud SDKs. This inventory answers: what does the codebase depend on, where is each dependency used, and is any dependency imported inconsistently or dangerously?

Find and assess ALL of these:
1. **Third-party packages** — `import X from 'some-package'`
2. **Node built-ins** — `import X from 'node:fs'` or `import X from 'path'`
3. **CDN/browser globals** — `window`, `document`, `navigator` usages
4. **Version-pinned imports** — imports that reference a specific version path

---

## Step 1 — Find All External Imports

```bash
grep -rn "^import\|^export.*from" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "'\.\.\|\"\.\./" | grep -v "^//" | head -80
```

Separate into:
- Node built-ins (path, fs, crypto, os, etc.)
- Third-party (everything else)

---

## Step 2 — Count Usage Frequency

```bash
grep -rhn "^import.*from '[^.][^.]\|^import.*from \"[^.][^.]" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | sed "s/.*from ['\"]//; s/['\"].*//; s/\/.*$//" | sort | uniq -c | sort -rn | head -30
```

High-frequency imports are core dependencies. Low-frequency imports may indicate abandoned experiments.

---

## Step 3 — Find Direct SDK / Service Imports

```bash
grep -rn "from '@aws-sdk\|from '@google-cloud\|from 'stripe\|from '@anthropic\|from 'openai\|from 'twilio\|from '@sendgrid\|from 'axios\|from 'got" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each SDK import: is it imported in exactly one place (the adapter/integration layer), or is it scattered across service files? Scattered SDK usage couples domain logic to vendor details.

---

## Step 4 — Find Browser-Only Globals

```bash
grep -rn "\bwindow\.\|\bdocument\.\|\bnavigator\.\|\blocalStorage\.\|\bsessionStorage\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

Browser globals in server-side code (`/app/api/`, `/services/`) will fail at runtime.

---

## Step 5 — Write the Inventory

Write one JSONL line per unique external dependency to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "external_imports"
- `kind`: "NPM_PACKAGE" | "NODE_BUILTIN" | "BROWSER_GLOBAL" | "CDN"
- `name`: package or module name (string)
- `file_path`: path of one representative importing file (string)
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `import_count`: integer (how many files import this package)
- `is_concentrated`: boolean (true if imported from a single adapter file)
- `is_scattered`: boolean (true if imported from 3+ different domain files)

Example:
{"entry_type":"external_imports","kind":"NPM_PACKAGE","name":"stripe","file_path":"src/integrations/stripe/client.ts","line_number":1,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","import_count":1,"is_concentrated":true,"is_scattered":false}

After all entries:
{"_summary":true,"entry_type":"external_imports","total_count":N,"by_kind":{"NPM_PACKAGE":0,"NODE_BUILTIN":0,"BROWSER_GLOBAL":0,"CDN":0},"scattered_sdks":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
