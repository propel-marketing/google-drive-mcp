# Universal Spec Format

Template for all spec outputs produced by `/task-orchestration convert-to-spec`.

This format is the bridge between planning material (raw notes, architecture:audit-to-spec outputs, free-form descriptions) and the task creation step. Every section maps to exactly one builder task.

---

```markdown
# Universal Spec — {Plan Name}

**Source:** {path to raw input material}
**Plan directory:** .agents/runs/{plan-name}/
**Created:** {date}
**Produced by:** {/architecture:audit-to-spec | manual synthesis | free-form conversion}

---

## 1. Context

### System Identity
{What the system is, what it does, who uses it. The mental model — not the file tree.
Include what the system explicitly cannot do. One paragraph max.}

### Problem Being Solved
{The specific gap or problem this work addresses. Why now. What breaks if this isn't done.}

### Boundaries
**In scope:** {explicit list of what this spec covers}
**Out of scope:** {explicit list of what is excluded, even if related}

---

## 2. File Manifest

Every section in §3 must reference at least one row here. Max 3 rows per section.

| # | Status | Path | Operation | Symbols Required | Symbols Forbidden |
|---|---|---|---|---|---|
| 1 | NEW | src/path/to/file.ts | create | ExportedFn, TypeName | — |
| 2 | MODIFIED | src/existing/file.ts | modify | newMethod | legacyMethod |
| 3 | DELETED | src/old/legacy.ts | delete | — | — |

**Operation values:**
- `create` — file does not exist yet, must be created
- `modify` — file exists, specific changes required
- `delete` — file must be removed entirely

**Symbols Required:** export names, function names, class names, column names that must be grep-findable in the final file
**Symbols Forbidden:** names that must NOT appear in the final file (removed APIs, deprecated patterns, etc.)

---

## 3. Sections

Each section = one builder task. Complete sections fully — the description here is the brief the builder receives.

### {N}. {Section Name} [{layer}]

**Layer:** schema | service | route | component | hook | config | test-assess | test | live | audit | infra | contract
**Phase:** {1 | 2 | 3 | ...}
**Depends on:** {section numbers, or "none" for Phase 1}
**Manifest rows:** {row numbers from §2}

**Intent:**
{What needs to happen and specifically why. What the current state is. What the desired end state is.
Enough context that the builder can make judgment calls without guessing.}

**Work items:**
1. {Exact action — file path, function name, what to create/change/remove}
2. {Exact action}
3. {Exact action}

**Acceptance criteria:**
- [ ] {Must-pass condition — grep-verifiable, compile-verifiable, or test-verifiable}
- [ ] {Must-pass condition}

**Verification:**
```bash
{Exact bash command to verify this section is complete}
```

**Testable outcome after this phase:** {HTTP endpoint(s) or UI interaction(s) the test skill can exercise once this phase completes, or "none — Foundation phase" for Phase 0 only}

---

*(Repeat §3 pattern for each section)*

---

## 4. Phase Structure

Prefer phases organized around domain capabilities (vertical slices). Cross-cutting phases (bug fixes, refactors, hardening that spans surface area) are valid when the work genuinely doesn't map to one capability. Each phase should be labeled: Feature, Foundation, or Cross-cutting.

| Phase | Type | Name | Sections | Testable Outcome | Can Parallelize |
|---|---|---|---|---|---|
| 0 | Foundation | Foundation | 1, 2 | none — shared infra | No |
| 1 | Feature | Auth | 3, 4, 5, 6 | POST /auth/login, POST /auth/register | 3+4 parallel, then 5, then 6 |
| 2 | Feature | Task Management | 7, 8, 9, 10 | GET /tasks, POST /tasks | 7+8 parallel, then 9, then 10 |
| 3 | Cross-cutting | Fix N+1 Query Bug | 11, 12, 13 | none — correctness across services | 11+12 parallel, then 13 |

**Dependency graph:**
```
Section 1 → Section 3
Section 2 → Section 3 → Section 7
Section 4 → Section 5 → Section 6
```

---

## 5. Constraints

### Hard Constraints
{What cannot change. Existing contracts. Platform limits. APIs that must not be modified.}

### Security Rules
{Auth boundaries. Data access rules. Input validation requirements. Org-scoping rules.}

### Anti-Requirements
{What this spec must NOT do. Patterns to avoid. Features explicitly excluded.}

### Naming Conventions
{File naming, function naming, type naming rules specific to this codebase.}
```

---

## Format Rules

1. **One section per task.** Never combine two independent changes into one section.
2. **Max 3 manifest rows per section.** If a section needs 4+ files, split it.
3. **Layer label is mandatory.** Every section must have exactly one layer.
4. **Phase 0 has zero dependencies.** Foundation work only — and it is the last horizontal phase.
5. **Prefer feature phases over layer phases.** Name phases after what they ship ("Auth", "Task Management") when possible. Cross-cutting work (bug fixes, refactors spanning surface area) is valid — label it as Cross-cutting and document its concern instead of a testable outcome. Every phase is one of: Feature, Foundation, or Cross-cutting.
6. **Symbols are grep patterns.** Write them as they would appear in source code (exact export names, not descriptions).
7. **Verification commands are exact.** The builder runs them verbatim — they must actually work.
8. **Intent explains WHY.** The work items explain WHAT. Both are required.
