# ADW — Diagnostics

Six checks. Run them against any codebase to locate architectural debt. Each check targets one specific failure mode, produces a verdict, and points to the exact files and lines that need work.

---

## Check 1 — The Grep Test

**What it finds:** Domain concepts that are unnamed, aliased, or fragmented.

**How to run:**
1. Identify the core domain nouns (3–5 for any feature)
2. For each noun, run: `grep -rn "NounName" ./src --include="*.ts" | grep -v node_modules`
3. Read the results as a story: origin → transformation → consumption

**Verdicts:**
- `COHERENT` — results trace a clean story. Concept is navigable.
- `FRAGMENTED` — results exist but tell multiple partial stories. Concept was renamed mid-journey.
- `ALIASED` — the canonical name has fewer results than one or more alias names. Fix by eliminating the aliases.
- `ABSENT` — near-zero results. The concept lives inside generic names (`data`, `result`, `payload`). It was never named.

**Worst signal:** The concept you expected to find most clearly is absent or aliased. This is the highest-priority rename.

**Output format:**
```
[NounName] — N matches in N files
Story: origin at [file:line] → transform at [file:line] → consumed at [file:line]
Verdict: COHERENT | FRAGMENTED | ALIASED | ABSENT
Worst alias: "[alias]" (N matches vs N canonical matches)
```

---

## Check 2 — Variable Name Audit

**What it finds:** Local variables named for their technical type rather than their domain role.

**How to run:** Open three files at random (prioritize route handlers, service methods, event handlers). Scan every `const` and `let` declaration.

**Red flags:**
- `data`, `res`, `obj`, `tmp`, `result`, `response`, `payload` without qualification
- `item`, `el`, `val`, `r`, `e` outside of narrow map/filter callbacks

**The rule:** Every variable name should answer the question "what is this?" without requiring the reader to trace back to where it was assigned.

| Bad | Good |
|-----|------|
| `const data = await fetch(...)` | `const rawApiPayload = await fetch(...)` |
| `const res = schema.parse(...)` | `const validatedSchema = schema.parse(...)` |
| `const result = db.query(...)` | `const databaseSchemaResponse = db.query(...)` |
| `const r = response.json()` | `const userProfileResponse = response.json()` |

**Output format:**
```
[file:line] — "[bad name]" should be "[domain name]"
Context: [one sentence on what the variable actually holds]
```

---

## Check 3 — Type Dissolution

**What it finds:** Every point where a typed value loses its type identity mid-journey.

**How to run:** Pick a core domain object. Follow it from entry point through every transformation. Flag each point where the type changes to `any`, `unknown`, an anonymous shape, or a generic `Record`.

**Fracture mechanisms:**
- `as any` / `as unknown` — explicit erasure
- `JSON.parse(str)` with no schema call immediately after
- `const { a, b } = someObj` where `someObj` is typed as `unknown`
- `.jsonb` database columns with no `.$type<>()` annotation
- Functions with no declared return type that infer `any`
- `!` non-null assertions without a preceding guard

**Severity:**
- `CRITICAL` — fracture at a layer boundary; downstream code trusts data that was never verified
- `MAJOR` — fracture mid-journey in a service or handler; compiler stops protecting from here
- `MINOR` — local cast, consequence contained within one function

**The unenforced contract check:** For each fracture point, grep for schemas or types that *should* be enforcing this boundary:
```bash
grep -rn "Schema\b\|safeParse\|\.parse(" ./src --include="*.ts"
```
A schema that exists but is never called at the actual entry point is an unenforced contract.

**Output format:**
```
Fracture at [file:line]
Type lost: [what it was]
Type after: [what it became — any | unknown | Record | anonymous shape]
Mechanism: EXPLICIT_CAST | JSON_PARSE | UNTYPED_JSONB | DESTRUCTURE | IMPLICIT_ANY | NONNULL_ASSERTION
Severity: CRITICAL | MAJOR | MINOR
Risk: [one sentence on what silently breaks if this cast is wrong]
```

---

## Check 4 — Responsibility Scatter

**What it finds:** Core logic that has no single owner — split across utility files, route handlers, helpers, and services.

**How to run:** Pick the most important operation in the feature (e.g., "process a payment", "send a message", "evaluate a workflow"). Grep for it. Follow every reference. Count how many files participate in owning that operation's logic.

**Red flags:**
- The same validation logic duplicated in two files
- A route handler containing business logic instead of delegating to a service
- A utility file with unrelated operations bundled together
- Logic spread across `helpers/`, `utils/`, and an inline function in the handler

**The ownership question:** For any core operation, there should be exactly one class or module you can point to and say "this is where [operation] lives." If you cannot point to one place, responsibility is scattered.

**Output format:**
```
Operation: "[core operation name]"
Owner: SINGLE (one class/file) | SCATTERED (N files participate)
Files involved: [list]
Scattered logic: [which files contain which fragments]
Recommendation: consolidate in [class name] — [file path]
```

---

## Check 5 — Interface Gap

**What it finds:** Layer boundaries with no explicit contract — layers that reach directly into each other's implementations.

**How to run:** Identify the layer boundaries in the feature (e.g., route → service → repository → database). At each boundary, check whether an interface or type defines the contract, or whether callers reference the concrete implementation directly.

**Red flags:**
- `import { DatabaseSchemaAnalyzer } from '../services/analyzer'` in a route handler — imports the class, not an interface
- No `interface ISchemaAnalyzer` exists anywhere in the codebase
- Mocking in tests requires replacing the entire module rather than substituting an implementation

**The seam test:** Can the implementation at layer N be swapped (for a mock, a different provider, a v2) without touching any code at layer N+1? If yes, the interface exists. If no, the gap exists.

**Output format:**
```
Boundary: [layer A] → [layer B]
Contract: EXPLICIT INTERFACE | TYPE ONLY | NONE
Concrete reference at: [file:line]
Swappable without downstream changes: YES | NO
Gap impact: [one sentence on what breaks if the implementation changes]
```

---

## Check 6 — Endpoint Drillability

**What it finds:** Endpoints that require multiple files to answer four basic questions.

**The four questions:**
1. What comes in? (exact input shape)
2. What comes out? (exact output shape on success)
3. What can fail? (all failure cases and status codes)
4. What does the user see? (the user-facing message in each case)

**How to run:** Open the route handler file for a key endpoint. Try to answer all four questions from that file alone. Count each additional file you must open.

**Scoring:**
| Files opened | Score |
|-------------|-------|
| 1 | EXCELLENT |
| 2 | GOOD |
| 3–4 | POOR |
| 5+ | BROKEN |

**Red flags:**
- Input schema lives in a separate `validation/` file
- Return type is implicit (inferred from what the service returns)
- Errors are thrown and caught by a global handler — failure paths not visible in the route
- User-facing messages are hardcoded strings scattered through the handler or don't exist

**Output format:**
```
Endpoint: [METHOD /path] at [file:line]
Q1 (in): answerable from route file YES | NO — requires [file]
Q2 (out): answerable from route file YES | NO — requires [file]
Q3 (failures): answerable from route file YES | NO — requires [file]
Q4 (user message): answerable from route file YES | NO | MISSING ENTIRELY
Additional files to drill: N
Score: EXCELLENT | GOOD | POOR | BROKEN
```

---

## Running the Full Audit

Run all six checks in parallel against the same feature. Aggregate findings by severity.

**Priority order for remediation:**
1. Type dissolution CRITICAL fractures — these cause silent runtime bugs
2. Missing schemas at entry points — unguarded boundaries
3. Responsibility scatter at core operations — hardest to debug under incident
4. Interface gaps at primary layer boundaries — blocks testability and swapping
5. Grep test ABSENT verdicts — rename to restore navigability
6. Variable name violations — mechanical rename, lowest risk, highest readability return

**The signal that a feature passes:** All six checks return no CRITICAL or MAJOR findings. Core domain concepts pass the grep test. Every layer boundary has a contract.
