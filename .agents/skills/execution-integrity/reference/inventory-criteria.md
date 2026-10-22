# Inventory Criteria

Each inventory file must emit:
- `id` — stable issue identifier
- `location` — `file:line` when available
- `finding` — short sentence
- `severity` — CRITICAL | MAJOR | MINOR
- `impact` — user-facing impact
- `remediation_hint` — minimal corrective direction
- `evidence` — concrete files, symbols, or routes
- `status` — observed | assumed | cannot-verify
