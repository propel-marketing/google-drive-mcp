# Inventory — Event Shapes

You are cataloging every event, message, and webhook payload shape in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Scope — What Belongs Here vs. Elsewhere

Events are data shapes that are published to, or consumed from, an asynchronous channel — queues, pub/sub, websockets, webhooks.

| Find here | Find elsewhere |
|-----------|---------------|
| Queue message payloads | Synchronous API request/response → inventory-data-transfer-objects |
| Pub/sub event shapes | UI state shapes → inventory-state-shapes |
| Webhook payloads (inbound from third parties) | Core domain entities → inventory-domain-models |
| Server-sent event shapes | Runtime validators → inventory-schemas |
| WebSocket message types | |

---

## Step 1 — Find Queue/Pub-Sub Message Types

```bash
grep -rn "Event\b\|Message\b\|Payload\b\|Job\b\|Task\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "export type\|export interface" | grep -v "Response\|Request\|Error" | head -30
```

```bash
grep -rn "emit(\|publish(\|enqueue(\|dispatch(\|queue\.add\|bull\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

For each publish/emit call: what type does the payload carry?

---

## Step 2 — Find Webhook Payload Types

```bash
grep -rn "webhook\|Webhook\|stripe\.\|twilio\.\|sendgrid\." {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep "export type\|export interface\|type.*=\|interface" | head -20
```

For each webhook payload: is it validated with a schema? Third-party webhooks must be validated — they are external data.

---

## Step 3 — Find Consumer Registrations

```bash
grep -rn "\.on(\|\.subscribe(\|\.consume(\|\.process(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -20
```

For each consumer: what event type does it process? Is the type explicit or `any`?

---

## Step 4 — Write the Inventory

Write one JSONL line per event shape to `{{OUTPUT_PATH}}` (extension must be `.jsonl`). Every line must be valid JSON.

Common fields (required):
- `entry_type`: "event_shapes"
- `kind`: "QUEUE_MESSAGE" | "PUBSUB_EVENT" | "WEBHOOK_PAYLOAD" | "WEBSOCKET_MESSAGE" | "SSE_EVENT"
- `name`: type name (string)
- `file_path`: path relative to codebase root
- `line_number`: integer
- `layer`: "frontend" | "backend" | "shared" | "infrastructure" | "unknown"
- `is_exported`: boolean
- `is_test_file`: boolean
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Type-specific fields (required):
- `direction`: "published" | "consumed" | "bidirectional"
- `schema_backed`: boolean
- `schema_ref`: string | null
- `channel`: string | null (queue name, topic, or "webhook:stripe" etc.)

Example:
{"entry_type":"event_shapes","kind":"QUEUE_MESSAGE","name":"SendEmailJob","file_path":"src/notifications/types.ts","line_number":22,"layer":"backend","is_exported":true,"is_test_file":false,"confidence":"parsed","direction":"published","schema_backed":false,"schema_ref":null,"channel":"email-queue"}

After all entries:
{"_summary":true,"entry_type":"event_shapes","total_count":N,"by_kind":{"QUEUE_MESSAGE":0,"PUBSUB_EVENT":0,"WEBHOOK_PAYLOAD":0,"WEBSOCKET_MESSAGE":0,"SSE_EVENT":0},"unvalidated_count":0,"status":"complete"}

---

Append as final line:
`Status: COMPLETE`
