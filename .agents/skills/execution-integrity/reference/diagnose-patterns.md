# Diagnose Pattern Library

When diagnosing, convert observations into:
- Failure sequence (Input -> decision -> action -> visible symptom -> user impact)
- Repeatability (manual steps to reproduce in priority order)
- Blast radius (single feature, project, org, system)
- Control boundary failure (assistant/backend/worker/ui)
- Recovery requirements (timeout, retry, rollback, hard-stop)

Only include items with direct evidence or strong code-level signal.
