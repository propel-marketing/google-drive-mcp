# Bounded Universal Spec template

Use this template for `spec-and-execute`. It is the canonical Universal Spec format from `task-orchestration/references/universal-spec-format.md` with bounded-spec additions placed where the converter does not parse them: an outcome statement, an evidence table and a requirement table inside §1, contract and test fields inside each section, and rollback, residual risk and definition-of-done inside §5. Keep every canonical heading and bold field name exactly as written. Delete the lines in angle brackets and every instruction line before conversion.

```markdown
# Universal Spec — <Plan Name>

**Source:** <request text, planning path with section, or record and artifact identifiers>
**Plan directory:** .agents/runs/<plan-name>/
**Created:** <yyyy-mm-dd>
**Produced by:** spec-and-execute

---

## 1. Context

### System Identity
<What the system is, what it does, who uses it, and what it explicitly cannot do. One paragraph.>

### Problem Being Solved
<The specific gap this work closes, why now, and what breaks if it is not done.>

### Boundaries
**In scope:** <explicit list>
**Out of scope:** <explicit list, including related work deliberately excluded and why>

### Outcome
<The exact user-visible or operational result when the plan is complete.>

### Current-state evidence

| Evidence | Current behavior | Source |
|---|---|---|
| E-001 | <verified fact> | `<file>:<symbol or line>` |

### Requirements

| ID | Requirement | Sections | Tests |
|---|---|---|---|
| R-001 | <precise, testable requirement> | 1 | T-001 |

---

## 2. File Manifest

Every section in §3 must reference at least one row here. Max 3 rows per section.

| # | Status | Path | Operation | Symbols Required | Symbols Forbidden |
|---|---|---|---|---|---|
| 1 | NEW | <exact path> | create | <ExportedName> | — |
| 2 | MODIFIED | <exact path> | modify | <newSymbol> | <removedSymbol> |

---

## 3. Sections

### 1. <Section Name> [<layer>]

**Layer:** <schema | service | route | component | hook | config | test-assess | test | live | audit | infra | contract>
**Phase:** <0 | 1 | 2 | ...>
**Depends on:** <section numbers, or "none">
**Manifest rows:** <row numbers from §2>

**Intent:**
<What needs to happen and why. Current state, desired end state, and the judgment calls the builder may make.>

**Contracts:**
- Inputs: <types, arguments, fields, events>
- Outputs: <return types, persisted rows, rendered state, emitted events>
- Invariants: <behavior that must remain true>
- Failure and recovery: <error, retry, fallback or rollback behavior>

**Work items:**
1. <Exact action: file path, symbol, what to create, change or remove>
2. <Exact action>

**Acceptance criteria:**
- [ ] <grep-verifiable, compile-verifiable or test-verifiable condition tied to R-nnn>
- [ ] <no-regression condition>

**Tests:**
- T-001: <test mode, exact behavior, expected result>
- T-002: <negative or recovery path>

**Verification:**
```bash
<exact command run from the repository root; add the other shell's spelling on the next line when both are plausible>
```

**UI state matrix:** <include only when the section changes user-facing behavior>

| State | Trigger | Visible result | Interaction and accessibility |
|---|---|---|---|
| Loaded | <trigger> | <result> | <keyboard, focus, semantics> |
| Empty | <trigger> | <result> | <behavior> |
| Error | <trigger> | <result> | <recovery> |

**Testable outcome after this phase:** <endpoint, interaction or command the test skill can exercise, or "none — Foundation phase" for Phase 0, or "none — Cross-cutting: <concern>">

---

*(Repeat the §3 pattern for each section.)*

---

## 4. Phase Structure

| Phase | Type | Name | Sections | Testable Outcome | Can Parallelize |
|---|---|---|---|---|---|
| 0 | Foundation | <name> | <sections> | none — shared infra | No |
| 1 | Feature | <name> | <sections> | <outcome> | <which sections run together> |

**Dependency graph:**
```
Section 1 → Section 2
```

---

## 5. Constraints

### Hard Constraints
<What cannot change: existing contracts, platform limits, protected areas, approved patterns.>

### Security Rules
<Authorization boundaries, data access rules, input validation, scoping rules; or "none affected".>

### Anti-Requirements
<What this spec must not do, with grep-verifiable forbidden symbols where possible.>

### Naming Conventions
<File, function and type naming rules specific to this codebase that the work must follow.>

### Verification matrix

| Test ID | Requirement IDs | Test mode | Command or file | Pass condition |
|---|---|---|---|---|
| T-001 | R-001 | <unit | integration | contract | browser | live> | `<path or command>` | <objective result> |

### Rollback and residual risk
- Rollback: <safe reversal path>
- Residual risk: <known limitation, or "none">

### Definition of done
- Every requirement has passing verification in the matrix above.
- Every managed builder and reviewer task is complete and final triage is CLEAN.
- Generated artifacts and task state are consistent.
- No unrelated file changes are included.
- Remaining risk and deferred work are recorded as tracked follow-up.
```
