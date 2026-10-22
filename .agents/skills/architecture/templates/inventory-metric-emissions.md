# Inventory — Metric Emissions

You are cataloging every metric emission call in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What You Are Looking For

Metric emissions are calls that record numeric measurements for monitoring dashboards and alerting. This inventory answers: where does the codebase emit metrics, and do those metrics include the context needed to filter and alert in production?

Find ALL of these:
- `metrics.increment(...)`, `metrics.decrement(...)`
- `metrics.gauge(...)`, `metrics.timing(...)`, `metrics.histogram(...)`
- `statsd.increment(...)`, `dogstatsd.*`
- `prometheus.counter(...)`, `prometheus.gauge(...)`, `prometheus.histogram(...)`
- Custom wrappers (`recordMetric(...)`, `trackEvent(...)`, `emitCount(...)`)

---

## Step 1 — Find All Metric Calls

```bash
grep -rn "metrics\.\|statsd\.\|prometheus\.\|counter\.\|histogram\.\|gauge\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "increment\|decrement\|gauge\|timing\|histogram\|observe\|set\|record" | head -40
```

```bash
grep -rn "recordMetric\|trackEvent\|emitCount\|emitMetric\|reportMetric" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

---

## Step 2 — Find Metric Library Imports

```bash
grep -rn "from 'prom-client\|from 'hot-shots\|from 'statsd\|from '@opentelemetry/api-metrics\|from 'datadog-metrics\|from 'dd-trace" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | head -15
```

Is the metric client imported in one place (adapter pattern) or scattered across domain files?

---

## Step 3 — Assess Tag / Label Coverage

```bash
grep -rn "metrics\.\|statsd\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "tags\|labels\|{" | head -20
```

For each metric call: does it include tags/labels (environment, service name, entity IDs) sufficient to filter alerts in production?

---

## Step 4 — Write the Inventory

Write one JSONL line per metric emission site to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "metric_emissions"
- `kind`: "COUNTER" | "GAUGE" | "HISTOGRAM" | "TIMING" | "CUSTOM"
- `name`: metric name string (e.g., "user.signup")
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: false
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `metric_lib`: string (e.g., "prom-client", "hot-shots", "dd-trace")
- `has_tags`: boolean (passes tags/labels object)
- `tag_keys`: string[] (list of tag key names, empty array if none)
- `is_concentrated`: boolean (metric client imported/used in single adapter file)

Example:
{"entry_type":"metric_emissions","kind":"COUNTER","name":"user.signup","file_path":"src/services/auth.ts","line_number":42,"layer":"backend","is_exported":false,"is_test_file":false,"confidence":"parsed","metric_lib":"hot-shots","has_tags":true,"tag_keys":["env","status"],"is_concentrated":false}

After all entries:
{"_summary":true,"entry_type":"metric_emissions","total_count":N,"by_kind":{"COUNTER":0,"GAUGE":0,"HISTOGRAM":0,"TIMING":0,"CUSTOM":0},"with_tags":0,"without_tags":0,"is_concentrated":false,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
