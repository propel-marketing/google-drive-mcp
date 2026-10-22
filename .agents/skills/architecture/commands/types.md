---
name: types
description: Catalog every TypeScript type alias and `any`/`unknown` usage; flag schema-derivation gaps and duplicate names.
argument-hint: "<codebase-path> [feature-name]"
---

# Inventory — Type Aliases

Audits every TypeScript type alias in the codebase: object shapes, unions, intersections, schema-derived (`z.infer`), utility applications, and scalar aliases. Flags `any`/`unknown` usages in trusted code, duplicate type names, and re-exported types that add indirection. Output feeds `/architecture/type-dissolution-check`.

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
OUTPUT_PATH    — ./.agents/runs/architecture/{YYYY-MM-DD}-{feature-name-hyphenated}/inventory/types.jsonl
```

Print resolved values before doing anything:

```
CODEBASE_PATH: /abs/path/to/project
FEATURE_NAME:  foundation
CODEBASE_NAME: Propel-ADW
OUTPUT_PATH:   ./.agents/runs/architecture/2025-01-15-foundation/inventory/types.jsonl
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
# Inventory — Type Aliases

You are cataloging every type alias in the **{{FEATURE_NAME}}** codebase at `{{CODEBASE_PATH}}`.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

Read these ADW reference files before beginning:
- ./.agents/skills/architecture/reference/01-principle.md
- ./.agents/skills/architecture/reference/02-building-blocks.md

---

## What You Are Looking For

Type aliases are the contracts that describe data shapes as they flow through the system. Find ALL of these:

1. **Type aliases** — `type UserId = string`, `type CreateUserInput = { ... }`
2. **Mapped types** — `type Partial<T>`, `type Pick<User, 'id' | 'email'>`
3. **Utility type applications** — `Omit<User, 'password'>`, `Required<Config>`
4. **Types inferred from schemas** — `type User = z.infer<typeof UserSchema>` (the correct pattern)
5. **Re-exported types** — types defined in one place and re-exported elsewhere (drift risk when re-export adds indirection)
6. **`any`, `unknown`, `object` usages** — points where type safety is intentionally or accidentally abandoned

For each type: what layer does it belong to (frontend, backend, shared)? What concept does it represent? Is it the authoritative definition or a duplicate? Is it derived from a schema (good) or declared independently (drift risk)?

This audit is **TYPES ONLY** — do not catalog `interface` declarations. Interfaces are covered by a separate command.

---

## Step 1 — Find All Type Aliases

```bash
grep -rn "^export type [A-Z][A-Za-z]* =\|^type [A-Z][A-Za-z]* =" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Separate matches into categories:
- **Object shapes** — `type Foo = { a: string; b: number }`
- **Union types** — `type Status = 'active' | 'inactive'`
- **Intersections** — `type FullUser = User & AuditFields`
- **Schema-derived** — `type Foo = z.infer<typeof FooSchema>`
- **Utility applications** — `type FooPartial = Partial<Foo>`
- **Scalar aliases** — `type UserId = string`

For each type alias found: read its full declaration. Note the shape, any unions/intersections, and what concept it represents.

---

## Step 2 — Find `any`, `unknown`, `object` Usages

```bash
grep -rn ": any\b\|<any>\|as any\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | grep -v "// eslint-disable"
```

```bash
grep -rn ": unknown\b\|<unknown>" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each `any`: is it at a boundary (acceptable — external API response before parse) or inside trusted code (problematic — type dissolution)?

---

## Step 3 — Find Re-exported Types

```bash
grep -rn "^export type { \|^export { type " {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

```bash
grep -rn "export \* from\|export type \* from" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next"
```

For each re-export: where is the canonical definition? How many hops does an agent need to trace to find it?

---

## Step 4 — Find Duplicate / Shadow Type Names

Look for type aliases with similar or identical names across different files:

```bash
grep -rn "^export type [A-Z][A-Za-z]*\b" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | sed 's/.*export type //' | awk '{print $1}' | sort | uniq -d
```

For each duplicate name: are these truly different concepts, or is the same concept defined in multiple places (drift risk)?

---

## Step 5 — Find Types Used at Layer Boundaries

Cross-reference types with backend routes and service signatures. For each backend route or service function: what TypeScript type does the input carry? What type does the response return? Is it schema-derived or independently declared?

```bash
grep -rn "Promise<\|: [A-Z][A-Za-z]*>\|: [A-Z][A-Za-z]*\[\]" {{CODEBASE_PATH}}/src/app/api --include="*.ts" | grep -v node_modules | grep -v ".next" | head -40
```

```bash
grep -rn "Promise<\|: [A-Z][A-Za-z]*>" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | head -40
```

---

## Step 6 — Write the Inventory

For each type alias found, write one entry:

```
### [Type Name]

Kind: TYPE_ALIAS | SCHEMA_DERIVED | UTILITY_APPLICATION | SCALAR_ALIAS | UNION | INTERSECTION
Location: [file:line]
Layer: frontend | backend | shared

Represents: [what concept this type describes — one sentence]

Shape: [brief — "id: string, email: string, createdAt: Date" or "union of 'active' | 'inactive'"]

Schema-derived: YES (from SchemaName at file:line) | NO (declared independently — drift risk)
Duplicate names: YES at [file:line] | NO
Contains `any`: YES at [specific fields] | NO

Re-exported from: [file:line] (if applicable)
```

For `any` usages that are in trusted code (not at a parsing boundary):

```
### `any` at [file:line] — TYPE DISSOLUTION

Context: [surrounding code — what function, what variable]
Is this at a boundary: YES (parsing external input) | NO (trusted code — violation)
What the type should be: [if determinable]
```

---

## Step 7 — Summary

```
## Types Inventory Summary

Total type aliases found: N
  Object shapes: N
  Schema-derived (z.infer): N — correct pattern
  Declared independently (drift risk): N
  String literal unions: N (potential enum candidates)
  Intersections: N
  Utility applications: N
  Scalar aliases: N

`any` usages: N total
  At boundaries (acceptable): N
  In trusted code (violation): N

`unknown` usages: N
Duplicate type names: N
Re-exported (indirection layers): N

Highest-priority issues:
1. [type at file:line] — [what's wrong: independently declared / duplicate / `any` in trusted code]
2. [any at file:line] — inside trusted code at [layer]
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
Inventory — Type Aliases complete

Codebase:  {CODEBASE_PATH}
Feature:   {FEATURE_NAME}
Output:    {OUTPUT_PATH}

Types found: N | Schema-derived (z.infer): N | Declared independently (drift risk): N | any in trusted code: N

Next:
  /architecture/type-dissolution-check {OUTPUT_PATH}
```
