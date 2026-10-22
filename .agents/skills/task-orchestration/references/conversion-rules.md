# Conversion Rules

How to convert raw planning material into the Universal Spec format.
Read this during `convert-to-spec` to classify input and produce correct section structure.

---

## Step 1: Classify the Input

Before extracting sections, identify what you're working with:

| Input Type | Signal | Approach |
|---|---|---|
| `/architecture:audit-to-spec` output | Numbered findings, "File Manifest" section, "Severity" labels | Direct extraction — map findings to sections (see §A) |
| Free-form design notes | Prose, verb phrases, no formal structure | Phrase extraction → section inference (see §B) |
| Architecture audit (raw) | CRITICAL/MAJOR/MINOR findings, file:line references | Convert findings by severity, skip MINOR unless grouped (see §C) |
| Code files (source) | .ts, .py, .tsx files | Run architecture audit first, then convert output |
| Mixed folder | Multiple types | Read all files, classify each piece, apply the matching approach |

---

## §A: Converting from /architecture:audit-to-spec Output

The audit-to-spec format already has structured findings. Translation is direct.

**Extraction rules:**
1. Each numbered finding → one candidate section
2. Group findings that touch the same file AND the same concern into one section
3. Never group findings across different layers
4. Extract file paths from "Affected files" or "Location" in each finding
5. Extract required symbols from "Remediation" or "What to change" directives
6. Extract forbidden symbols from "Remove", "Delete", "Replace" directives

**Severity → priority:**
| Severity | Treatment |
|---|---|
| CRITICAL | Phase 1 if structural, Phase 2 if behavioral |
| MAJOR | Phase 2 or 3 depending on layer |
| MINOR | Group with related MAJOR or skip if standalone |
| INFO | Include in AGENT_SYSTEM.md as context, not a task |

---

## §B: Converting from Free-Form Notes

**Step 1 — Extract verb phrases:**
Scan for action language: "add X", "create Y", "remove Z", "refactor W", "migrate A to B", "fix C", "implement D"

Each distinct verb phrase is a candidate section.

**Step 2 — Group by file:**
If two verb phrases touch the same file, they can be one section — unless they're different layers (e.g., schema change + route change on the same file = two sections).

**Step 3 — Infer layer from the noun:**
| Noun pattern | Layer |
|---|---|
| database, table, column, migration, index | schema |
| type, interface, schema, model (Pydantic/Zod) | contract |
| function, service, logic, calculation, AI call | service |
| endpoint, route, handler, API | route |
| hook, useQuery, useMutation | hook |
| component, page, layout, UI, button, form | component |
| test, spec, scenario | test |
| WebSocket, SSE, cron, queue, background job | infra |
| env, config, register, main.py, index.ts | config |

**Step 4 — Derive file paths:**
If notes mention specific file names → use those.
If notes are generic ("add a function") → generate paths following existing codebase conventions.
If conventions are unknown → mark path as `TBD` and note in AGENT_SYSTEM.md that architecture agent should resolve.

**Step 5 — Derive symbols:**
Required symbols = the export name of what's being created (function name, class name, etc.)
Forbidden symbols = anything explicitly being removed ("delete the legacy fallback" → symbol forbidden)

---

## §C: Converting from Architecture Audit (Raw Findings)

Raw audits have file:line findings. Convert to sections, not individual findings.

**Grouping rule:**
Group findings from the same file into one section when:
- They're the same layer
- They would be fixed in the same edit session
- Combined, they need ≤3 files

**Section name = the concern, not the finding:**
- Not: "Fix line 47 in auth.ts"
- Yes: "Remove Ahrefs dependency from auth service"

**Extract symbols from remediation text:**
- "Remove the `ahrefsKey` parameter" → `symbolsForbidden: ["ahrefsKey"]`
- "Add `validateOrgScope` to the handler" → `symbolsRequired: ["validateOrgScope"]`
- "Export `UserSchema` from the contract module" → `symbolsRequired: ["UserSchema"]`

---

## Phase Assignment Rules

**Prefer phases organized around domain capabilities (vertical slices) over phases organized around technical layers (horizontal).**

This is a preference, not a rule. Some work is inherently cross-cutting — bug fixes that touch 8 files across multiple domains, security hardening across all routes, a performance refactor spanning schema + service + route. These don't fit clean vertical slices and shouldn't be forced into them. Organize those phases by concern ("Fix N+1 Query", "Auth Hardening") rather than feature or layer.

For greenfield features and new capabilities, prefer vertical slices.

### Phase types

**Foundation phase** — shared infra only (shared types, DB setup, auth middleware, global config). Horizontal by nature. Keep thin. Usually Phase 0.

**Feature phase (preferred)** — one domain capability, all its layers. Named for what it ships:

```
Phase 1: Auth               (schema → service → route → component — POST /auth/login testable)
Phase 2: Task Management    (schema → service → route → component — GET/POST /tasks testable)
```

**Cross-cutting phase** — a concern that spans multiple features or the full stack. Acceptable when the work genuinely doesn't map to one capability:

```
Phase 3: Fix N+1 Query Bug      (touches 4 services, 2 routes — horizontal but valid)
Phase 4: Rate Limiting Hardening (spans all API routes — horizontal but valid)
```

**The testable outcome check:** For feature phases, ask before finalizing: "After this phase, what can the test skill call?" If nothing, consider whether consumer sections are missing. For cross-cutting phases, the check doesn't apply — the goal is correctness across surface area, not a new callable endpoint.

### Layer ordering within a phase

Within any phase, sequence sections by their layer dependencies:

| Layer | Runs After |
|---|---|
| schema | — |
| contract | — (can parallel with schema) |
| service | schema + contract |
| infra | service |
| route | service |
| hook | route |
| component | hook or route |
| test | what it tests |
| config | what it configures |

**Parallelism rule:**
Sections in the same phase can parallelize ONLY if they touch zero shared files.
If two sections in the same phase modify the same file → sequence them.

**Dependency graph rule:**
Section B depends on Section A when:
- B imports something A creates
- B modifies a file A creates
- B's acceptance criteria require A to have passed

---

## Manifest Operation Rules

| Situation | Operation |
|---|---|
| File doesn't exist in codebase | `create` |
| File exists, changes required | `modify` |
| File being removed entirely | `delete` |
| Unsure if file exists | `modify` (safer — fails gracefully if wrong) |

---

## Section Splitting Rules

Split a section when:
- It would need >3 manifest rows
- It spans two layers (e.g., both schema change and route change)
- Its work items can be done independently and in parallel
- It's the only task blocked behind a phase gate (splitting unlocks parallelism)

Do NOT split when:
- The work is tightly coupled (can't ship one without the other)
- Both parts touch the same file in the same way
- Splitting would create a section with <2 work items

---

## Quality Checklist

Run before writing universal-spec.md:

- [ ] Every section has exactly one layer label
- [ ] Every section has ≥1 manifest row
- [ ] No section has >3 manifest rows
- [ ] Phase 0 sections have `Depends on: none`
- [ ] Later phases only depend on lower-numbered phases
- [ ] Each phase is identified as Feature, Foundation, or Cross-cutting — not just a layer name
- [ ] Feature phases have a declared testable outcome (≥1 callable endpoint or UI interaction)
- [ ] Cross-cutting phases document their concern and scope instead of a testable outcome
- [ ] Symbols Required are exact export/function names (grep-able)
- [ ] Symbols Forbidden come from explicit "remove" directives only
- [ ] File paths follow codebase naming conventions (or are marked TBD)
- [ ] Constraints section is populated
- [ ] Every section's Verification command is a real, runnable bash command
