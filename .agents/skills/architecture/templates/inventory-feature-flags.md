# Inventory — Feature Flags

You are cataloging every feature flag in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Every feature flag — flags gate functionality and are invisible load-bearing elements. A flag that exists in code but isn't in the audit means a build can silently enable or disable behavior that was never accounted for. Covers: dedicated flag libraries (LaunchDarkly, GrowthBook, Statsig, PostHog), environment-variable gates (`process.env.FEATURE_*`, `NEXT_PUBLIC_*`), and inline boolean config values used as gates.

Read `{{CODEBASE_PATH}}/package.json` first to identify which flag libraries are present.

---

## Step 1 — Find Flag Library Usage

```bash
grep -rEn 'useFlag\b|getFeature\b|useFeature\b|isEnabled\b|launchdarkly|growthbook|statsig|posthog' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

---

## Step 2 — Find Environment-Variable Gates

```bash
grep -rEn 'process\.env\.FEATURE_|process\.env\.NEXT_PUBLIC_FEATURE_|process\.env\.ENABLE_|process\.env\.DISABLE_' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.'
```

Also check `.env` files for flag-shaped variables:
```bash
grep -rEn '^FEATURE_|^NEXT_PUBLIC_FEATURE_|^ENABLE_|^DISABLE_' {{CODEBASE_PATH}}/.env {{CODEBASE_PATH}}/.env.example {{CODEBASE_PATH}}/.env.local 2>/dev/null
```

---

## Step 3 — Find Inline Boolean Config Gates

```bash
grep -rEn 'const (is|enable|disable|show|hide)[A-Z]' {{CODEBASE_PATH}}/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE '(test|spec)\.' | head -30
```

---

## Step 4 — Check Flag Centralization

Flags scattered across files are harder to audit. Check whether there is a central flags file:

```bash
find {{CODEBASE_PATH}}/src -name "flags*" -o -name "features*" -o -name "feature-flags*" 2>/dev/null | grep -v node_modules | grep -v test
```

---

## Step 5 — Write the Inventory

Write one JSONL line per flag to `{{OUTPUT_PATH}}`. Every line must be valid JSON.

Required fields:
- `entry_type`: "feature_flags"
- `name`: flag key or variable name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `kind`: "library" | "env_var" | "inline_config"
- `library`: "launchdarkly" | "growthbook" | "statsig" | "posthog" | "none" | "unknown"
- `is_centralized`: boolean (false = defined/used inline only, not in a flags registry)
- `consumer_count`: integer (number of files that reference this flag)
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
```json
{"entry_type":"feature_flags","name":"FEATURE_NEW_DASHBOARD","file_path":"src/config/flags.ts","line_number":12,"kind":"env_var","library":"none","is_centralized":true,"consumer_count":3,"is_test_file":false,"confidence":"parsed"}
```

After all entries, write the summary:
```json
{"_summary":true,"entry_type":"feature_flags","total_count":N,"library_flags":0,"env_flags":0,"inline_flags":0,"uncentralized_count":0,"status":"complete"}
```

If no flags found:
```json
{"_summary":true,"entry_type":"feature_flags","total_count":0,"status":"empty"}
```

---

Status: COMPLETE
