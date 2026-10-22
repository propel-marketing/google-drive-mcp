---
name: execution-integrity-run
description: Run the full execution-integrity workflow across inventory, diagnose, synthesis, and spec
argument-hint: "<CODEBASE_PATH> [feature-name]"
---

# execution-integrity-run

```bash
CODEBASE_PATH=${1}
FEATURE_NAME=${2:-full codebase}
ARCHITECTURE_RUN=${3:-}
DATE_SLUG="$(date +%Y-%m-%d)"
FEATURE_SLUG="$(echo "${FEATURE_NAME}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
OUTPUT_DIR="./.agents/runs/execution-integrity/${DATE_SLUG}-${FEATURE_SLUG}"
```

Create run directories:
```bash
mkdir -p "${OUTPUT_DIR}/inventory" "${OUTPUT_DIR}/diagnose" "${OUTPUT_DIR}/plan" "${OUTPUT_DIR}/issues" "${OUTPUT_DIR}/spec"
```

Read:
- `.agents/contracts/execution-integrity.manifest.json`
- `.agents/skills/execution-integrity/commands/inventory.md`
- `.agents/skills/execution-integrity/commands/diagnose.md`
- `.agents/skills/execution-integrity/commands/synthesize.md`
- `.agents/skills/execution-integrity/commands/convert-to-spec.md`
- `.agents/skills/execution-integrity/reference/architecture-reuse.md`

Architecture reuse wiring:
- If `ARCHITECTURE_RUN` is provided, read:
  - `${CODEBASE_PATH}/${ARCHITECTURE_RUN}/issues/issues-enriched.jsonl`
  - `${CODEBASE_PATH}/${ARCHITECTURE_RUN}/plan/synthesis-*.md`
  - `${CODEBASE_PATH}/${ARCHITECTURE_RUN}/spec/universal-spec.md`
- If not provided, detect latest run with:
  - `${CODEBASE_PATH}/.agents/runs/architecture/*` and consume the newest directory.
- Record which architecture artifact IDs are reused directly into each inventory/synthesis artifact.

Then execute each phase in order:
1. Inventory
2. Diagnose
3. Synthesize
4. Spec conversion

Final artifacts:
- `${OUTPUT_DIR}/issues/issues.jsonl`
- `${OUTPUT_DIR}/issues/issues-enriched.jsonl`
- `${OUTPUT_DIR}/spec/universal-spec.md`

After finishing, print `Status: COMPLETE`.
