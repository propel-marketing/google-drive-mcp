---
name: execution-integrity
description: Runtime and workflow integrity audit. Evaluates execution reliability, task lifecycle correctness, AI assistant/tool orchestration, queue/job state, mobile/desktop UX parity, and operational recovery paths that impact production usability.
argument-hint: "<codebase-path> [feature-name]"
---

# Execution Integrity Skill

Use this skill when architecture-level correctness is passing but behavior is fragile in production flows. It audits end-to-end runtime reliability for assistant-driven workflows, campaign/start pipelines, background jobs, and core user interactions.

Runtime contract:
- `.agents/contracts/execution-integrity.manifest.json` defines the phase graph.
- `.agents/skills/execution-integrity` owns command prompts, reference, and templates.
- This skill outputs artifacts into `.agents/runs/execution-integrity/<date-feature>/` for downstream conversion to task plans.

This skill is intentionally distinct from `architecture`:
- `architecture`: static design quality, typed boundaries, layering, contracts
- `execution-integrity`: live runtime behavior, process contracts, tool handoff correctness, state cleanup, and UI execution affordances

`execution-integrity` should reuse relevant architecture outputs when available and only add new investigation where existing findings do not cover runtime or execution sequencing behavior.

Trace strategy:
- If architecture artifacts exist for the same codebase, reuse them as baseline context before opening files.
- Use architecture signals for:
  - ownership patterns,
  - existing risk taxonomies,
  - prior severity labels,
  - and known symbol-level findings.
- Do not duplicate architecture-only findings. Add only execution-specific deltas (timing, runtime sequencing, handoff loops, stale-state behavior, and tool-call runtime integrity).
- If execution and architecture findings disagree, execution findings are authoritative for runtime behavior and must note the divergence path.

## Default Process (4 phases)

Phase 1 — Inventory:
- Capture evidence of runtime behavior surfaces: queue/job states, assistant/tool integration points, navigation/filter controls, notification state, and readiness gating.

Phase 2 — Diagnose:
- Turn inventory into concrete failure classes with reproducible scenarios and likely user impact.

Phase 3 — Synthesize:
- Produce execution-risk remediations organized by user-facing and system-facing control points.
- Produce ecosystem handoff and a principles-style integrity audit.
- Assemble JSONL issues and enriched variants for plan conversion.

Phase 4 — Spec:
- Convert synthesis into `universal-spec.md` consumable by task orchestration.

---

## Reference Material

Templates, commands, and reference docs are available under:
- `.agents/skills/execution-integrity/commands`
- `.agents/skills/execution-integrity/templates`
- `.agents/skills/execution-integrity/reference`

## Arguments

```
$ARGUMENTS: <codebase-path> [feature-name]

codebase-path  — absolute path to the codebase root (required)
feature-name   — optional, defaults to "full codebase"
```

## Step 1 — Parse Inputs

1. Resolve `CODEBASE_PATH` from first token and verify it exists.
2. Resolve `FEATURE_NAME` from second token or default `"full codebase"`.
3. Resolve `CODEBASE_NAME` as basename of `CODEBASE_PATH`.
4. Resolve `DATE_SLUG = YYYY-MM-DD`.
5. Resolve `FEATURE_SLUG` by lowercasing and hyphenating `FEATURE_NAME`.
6. Resolve `OUTPUT_DIR = ./.agents/runs/execution-integrity/${DATE_SLUG}-${FEATURE_SLUG}`.

Print:
```
/execution-integrity
Codebase: {CODEBASE_PATH}
Feature: {FEATURE_NAME}
Output: {OUTPUT_DIR}
```

## Step 2 — Setup

```bash
mkdir -p "${OUTPUT_DIR}/inventory"
mkdir -p "${OUTPUT_DIR}/diagnose"
mkdir -p "${OUTPUT_DIR}/plan"
mkdir -p "${OUTPUT_DIR}/issues"
mkdir -p "${OUTPUT_DIR}/spec"
```

## Step 3 — Build Context

Read:
- `CODEBASE_PATH/package.json` for dependency shape
- `CODEBASE_PATH/README.md` if present
- `CODEBASE_PATH/src` directory listing
- Latest architecture artifacts if available under `CODEBASE_PATH/.agents/runs/architecture/<latest>/`:
  - `issues/issues-enriched.jsonl`
  - `plan/synthesis-*.md`
  - `spec/universal-spec.md`

When architecture artifacts are missing or stale, inventory may fallback to full investigation without reuse.

Then run command prompts from `.agents/skills/execution-integrity/commands` according to the manifest.

## Step 4 — Finalization

- Validate phase outputs exist in expected locations.
- Ensure status markers are complete before passing to conversion/plan tooling.
- Convert to tasks through standard `/task-orchestration convert-to-tasks` using the generated `spec/universal-spec.md`.
