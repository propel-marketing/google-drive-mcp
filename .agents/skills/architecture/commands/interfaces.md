---
name: interfaces
description: Catalog every TypeScript interface, classes implementing them, and layer boundaries lacking explicit contracts.
argument-hint: "<codebase-path> [feature-name]"
---

# Inventory — Interfaces

Audits every TypeScript interface in the codebase, identifies which classes implement them, finds classes without an interface contract, and flags layer boundaries crossed without an explicit interface. Output feeds `/architecture/interface-gap-check`.

---

## Variables

```
$ARGUMENTS: <codebase-path> [feature-name]

codebase-path  — absolute path to the codebase root (required)
feature-name   — name of the feature or domain to audit (optional; defaults to "full codebase")
```

Parse and derive:

```
CODEBASE_PATH  — from $ARGUMENTS (first token); must be an absolute path
FEATURE_NAME   — from $ARGUMENTS (second token); default: "full codebase"
CODEBASE_NAME  — last path segment of CODEBASE_PATH
               e.g. /Users/vilovieta/Projects/Propel-ADW → Propel-ADW
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/inventory/interfaces.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/inventory/interfaces.jsonl
```

If CODEBASE_PATH does not exist, stop: `Cannot run — path does not exist: {CODEBASE_PATH}`

---

## Setup

```bash
mkdir -p "$(dirname {OUTPUT_PATH})"
```

---

## Context Block

Read the codebase to build project context. Prepend this block to the agent brief.

Read:
- `{CODEBASE_PATH}/package.json` (or equivalent) → tech stack, dependencies
- `{CODEBASE_PATH}/README.md` if present → what the app does
- `{CODEBASE_PATH}/src` directory listing → folder structure overview

Format:

```
## System Identity
[What CODEBASE_NAME is, what it does, who uses it, what FEATURE_NAME is responsible for. 2-3 sentences.]

## Architecture Context
[Tech stack with versions. Key patterns. How layers connect.]

## Constraints
[Read-only — never write source files. Only write to OUTPUT_PATH.]

## Current State
[Prior findings if any. "No prior audit" if first run.]
```

---

## Execution

Use the agent prompt below directly (no external template file). Substitute `{{CODEBASE_PATH}}`, `{{FEATURE_NAME}}`, and `{{OUTPUT_PATH}}` with their resolved values, prepend the Context Block, and spawn one `auditor` agent.

Agent prompt:

```
# Inventory — Interfaces

You are cataloging every TypeScript interface in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

Read these ADW reference files before beginning:
- ./.agents/skills/architecture/reference/01-principle.md
- ./.agents/skills/architecture/reference/02-building-blocks.md

---

## What You Are Looking For

Interfaces are the explicit contracts that define what a class promises to its callers. A class without an interface is a class without a documented contract — callers must read the implementation to know what it does. A layer boundary crossed without an interface is a place where coupling leaks across architectural seams.

Find ALL of these:

1. **TypeScript interfaces** — `interface UserRecord { id: string; email: string }`, `interface IUserRepository { findById(id: string): Promise<User> }`
2. **Interface inheritance** — `interface AdminUser extends User { ... }`
3. **Classes that implement interfaces** — `class UserRepository implements IUserRepository { ... }`
4. **Classes without interfaces** — services, repositories, or other classes that have no `implements` clause and no separate interface declaration
5. **Layer boundaries without contracts** — places where a route handler calls a service, or a service calls a repository, but the dependency is on a concrete class rather than an interface

This audit is **INTERFACES ONLY** — do not catalog `type` aliases. Type aliases are covered by a separate command.

---

## Step 1 — Find All Interfaces

```bash
grep -rn "^export interface\|^interface " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each interface found: read its full declaration. Note all fields/methods, their types, and any `extends` relationships.

---

## Step 2 — Find Classes Implementing Interfaces

```bash
grep -rn "class [A-Z][A-Za-z]* implements " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each match: which interface(s) does the class implement? Read the class to confirm it actually satisfies the contract (no missing methods, no widened return types).

---

## Step 3 — Find All Classes (to detect classes without interfaces)

```bash
grep -rn "^export class\|^class " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Cross-reference with Step 2. For each class:
- Does it implement an interface? (yes — paired)
- Is its name shadowed by a separate `IClassName` or `ClassNameContract` interface in another file? (yes — paired but separate)
- Does it have no interface at all? (no contract — flag it)

Pay particular attention to **service classes**, **repository classes**, and **adapter classes** — these are the ones that benefit most from explicit contracts because they sit at layer boundaries.

---

## Step 4 — Find Interface Re-exports

```bash
grep -rn "^export { .*[A-Z][A-Za-z]*.* }\|^export interface " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "export \* from" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each interface re-export: where is the canonical definition? How many hops to find it?

---

## Step 5 — Find Layer Boundaries Without Contracts

A layer boundary is a place where one architectural layer (route handler, service, repository, adapter) calls into another. At each such boundary, the dependency should be on an interface, not a concrete class.

Look for direct concrete-class instantiation or import at boundaries:

```bash
grep -rn "new [A-Z][A-Za-z]*Service(\|new [A-Z][A-Za-z]*Repository(" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

```bash
grep -rn "import { [A-Z][A-Za-z]*Service \|import { [A-Z][A-Za-z]*Repository " {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | head -30
```

For each match: is the consumer depending on a concrete class or on an interface? If concrete, this is a missing contract at the boundary.

---

## Step 6 — Write the Inventory

For each interface found, write one entry:

```
### [Interface Name]

Location: [file:line]
Layer: frontend | backend | shared

Represents: [what concept this contract describes — one sentence]

Shape: [brief — "findById(id), save(user), delete(id)" for behavioral interfaces; "id: string, email: string" for data interfaces]

Extends: [parent interface(s) at file:line] | NONE
Implementing classes: [list ClassName at file:line] | NO IMPLEMENTERS
Consumers depend on interface: YES | NO (consumers depend on concrete class at file:line)

Re-exported from: [file:line] (if applicable)
```

For each class without an interface (especially services/repositories/adapters):

```
### [ClassName] — NO INTERFACE CONTRACT

Location: [file:line]
Kind: SERVICE | REPOSITORY | ADAPTER | OTHER
Public methods: [list — these are the de facto contract]
Callers: [list file:line of consumers]
Sits at layer boundary: YES (between [layer A] and [layer B]) | NO
Recommendation: [extract interface I[ClassName] | acceptable as-is because [reason]]
```

---

## Step 7 — Summary

```
## Interfaces Inventory Summary

Total interfaces found: N
  With at least one implementing class: N
  Without any implementing class (data shapes only): N
  Extending another interface: N
  Re-exported (indirection layers): N

Total classes found: N
  With explicit `implements` clause: N
  With separate paired interface (no `implements`): N
  With no interface at all: N
  At layer boundaries without interface: N (highest concern)

Layer boundaries with concrete-class dependency (missing contract): N

Highest-priority issues:
1. [class at file:line] — service/repository at layer boundary without an interface
2. [interface at file:line] — defined but never implemented (dead contract)
3. [boundary at file:line] — consumer imports concrete class instead of interface
...
```

---

Append as final line:
`Status: COMPLETE`
```

Prepend Context Block to the filled prompt.

Spawn one `auditor` agent with the combined prompt.

Wait for completion. Read the last line of `{OUTPUT_PATH}`. Parse it as JSON and confirm it has `"_summary":true` and `"status":"complete"`.

If the agent writes `Status: NEEDS_MORE_CONTEXT`, surface the exact message and stop.

---

## Report

After the agent completes, print:

```
Inventory — Interfaces complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Interfaces found: N | With implementing class: N | Without implementing class: N | Classes with no interface: N

Next:
  /architecture/interface-gap-check {OUTPUT_PATH}
```
