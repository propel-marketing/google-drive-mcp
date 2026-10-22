# Inventory — Config

You are cataloging every configuration access point in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Configuration access is how the codebase reads environment variables, feature flags, and runtime settings. This inventory answers: how many env var reads exist, are they centralized or scattered, is there validation at startup, and where are feature flags consumed?

Find ALL of these:
- `process.env.SOME_VAR` — direct env reads
- `env.SOME_VAR` — validated env object reads
- Feature flag checks: `featureFlags.isEnabled(...)`, `flagsmith.hasFeature(...)`, `growthbook.isOn(...)`
- Config module reads: `config.get(...)`, `getConfig().something`

---

## Step 1 — Find All process.env Reads

```bash
grep -rn "process\.env\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -50
```

Count unique variable names accessed:
```bash
grep -rhn "process\.env\.\([A-Z_]*\)" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -oP "process\.env\.[A-Z_]+" | sort -u
```

---

## Step 2 — Find Config/Env Validation Modules

```bash
grep -rn "zod\|joi\|yup\|t\.string\|z\.string" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -i "env\|config" | head -20
```

```bash
find {{CODEBASE_PATH}}/src -name "env.ts" -o -name "config.ts" -o -name "env.mjs" -o -name "config.mjs" | grep -v node_modules | grep -v ".next"
```

Is there a single validated config/env module that all others import from? Or are `process.env` reads scattered throughout domain files?

---

## Step 3 — Find Feature Flag Checks

```bash
grep -rn "isEnabled\|hasFeature\|isOn\|getFeatureValue\|featureFlags\.\|growthbook\.\|flagsmith\.\|launchdarkly\.\|unleash\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

---

## Step 4 — Find .env Files

```bash
find {{CODEBASE_PATH}} -name ".env*" -not -path "*/node_modules/*" -not -path "*/.next/*" | head -10
```

```bash
find {{CODEBASE_PATH}} -name ".env.example" -o -name ".env.template" | grep -v node_modules | head -5
```

---

## Step 5 — Write the Inventory

Write one JSONL line per configuration access site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "config"
- `kind`: "ENV_VAR" | "FEATURE_FLAG" | "CONFIG_MODULE" | "HARDCODED_DEFAULT"
- `name`: variable or flag name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `is_validated`: boolean (read through a schema-validated config module)
- `has_default`: boolean (falls back to a default if unset)
- `is_secret`: boolean (likely a secret: contains KEY, SECRET, TOKEN, PASSWORD, PRIVATE)
- `access_pattern`: "direct" | "via_module" | "via_flag_sdk"

Example:
{"entry_type":"config","kind":"ENV_VAR","name":"DATABASE_URL","file_path":"src/db/client.ts","line_number":5,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","is_validated":false,"has_default":false,"is_secret":true,"access_pattern":"direct"}

After all entries:
{"_summary":true,"entry_type":"config","total_count":N,"by_kind":{"ENV_VAR":0,"FEATURE_FLAG":0,"CONFIG_MODULE":0,"HARDCODED_DEFAULT":0},"validated_count":0,"direct_process_env_count":0,"secret_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
