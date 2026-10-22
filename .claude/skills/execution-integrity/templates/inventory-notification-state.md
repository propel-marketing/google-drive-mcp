# Inventory: Notification State

Audit notification and bell-state persistence, including clear/dismiss behavior and unread counts.

Emit to `{{OUTPUT_PATH}}/inventory/notification-state.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"notification-state"}`

Capture both client and server responsibilities if split.
