# Inventory: Tool Load Path

Audit all code paths that register, select, describe, and load assistant tools.

Read:
- tool registries
- tool wrappers/invokers
- tool-selection prompts

Emit findings to `{{OUTPUT_PATH}}/inventory/tool-load-path.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"tool-load-path"}`

Track especially:
- stale/hidden tool definitions
- missing description-based introspection
- default tool fallback behavior
- tool contract/schema mismatches
