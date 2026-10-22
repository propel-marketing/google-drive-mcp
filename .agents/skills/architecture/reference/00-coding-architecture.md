# The Final Coding Bible

## Codebase Structural Principles
### A Language-Agnostic Guide for Agents

---

## What This Guide Is

This is a description of how well-organized codebases are structured at the level of files, folders, names, and types. It is not a tutorial. It is not a framework. It is a set of rules that hold across languages, frameworks, and project sizes — distilled from observing what works in real production codebases and what fails when growth pressure exposes weak structure.

If you are an agent reading this before touching a codebase: this guide gives you the mental model that lets you navigate, modify, or build without guessing. After reading it you should be able to look at any folder tree and form a hypothesis about what each folder does, what each file's role is, and where new code should go — before opening a single file.

## Why This Guide Exists

Codebases rot for one reason: there is no clear answer to the question "where does this go?" New code drifts into whichever folder felt least wrong at the time. Names accumulate without convention. Files grow because nobody can see when they should split. After a year, the codebase reflects the accumulated panic decisions of every person who passed through it — not a coherent design.

The fix is not better discipline. The fix is making structure carry the load that discipline normally has to carry. When the folder you are in tells you the naming convention, when the file's role tells you whether it should split, when a closed set of values has a closed type — the questions have default answers. The structure stays consistent over years because every decision has an obvious place.

This matters more for agents than for humans. A human can ask another human "where does this go?" An agent has only the codebase itself. If structure is doing its job, the agent reads the structure and knows. If structure is muddled, the agent guesses. Guessing is the root cause of bad code generation.

## How To Read This

Each numbered section below follows the same shape:

1. **Observation** — what the pattern looks like in working codebases.
2. **Principle** — the rule extracted from the pattern, marked with a bold **Principle.** prefix.
3. **Translation** — how the principle manifests in different languages, since the underlying rule is universal but the mechanism differs.
4. **Failure mode** — what violations look like, so you can recognize them in the wild.
5. **Diagnostic** — a question you can ask of any codebase to check whether the principle is being followed.

Read the whole guide once before applying any of it. Several principles depend on others; misapplying one in isolation produces worse code than ignoring all of them.

## What This Is Not

This guide is not framework-specific. It does not assume React, Django, Spring, or any other framework. It does not prescribe Zod, Mongoose, or any specific library. It does not tell you which test runner to use.

This guide is not a template. You cannot paste its folder structure onto a project and expect good results. The principles are inputs to your structural decisions, not outputs.

This guide does not cover everything. It covers structure — the part of architecture that makes a codebase navigable. It does not cover algorithm design, performance tuning, security, or domain modeling. Those are separate concerns with separate principles.

---

## The Grep Test — Run This First

Before applying any section in this guide, run the grep test. It takes sixty seconds and tells you whether the principles were ever applied.

Pick a core domain concept from the codebase you are about to touch — a noun that should be central: `User`, `Order`, `Capability`, `Transaction`, `Schedule`. Grep for it across all source files.

**Three outcomes:**

- The results tell a coherent story — origin, transformation, consumption — with the concept appearing in a small number of well-named locations. The codebase is well-structured. Follow its conventions.
- You find nothing, or the concept appears only in data schemas. The concept was never named in code. It lives as implicit string literals or anonymous object shapes. The naming principle was never applied. Treat every other principle as potentially unapplied too.
- You find 200–400 results spread across every layer and file. The name is too generic to carry meaning. It is a database column name masquerading as a domain concept. Pick a more specific name and re-run.

Run the grep test again at the end of your work — after adding new code. Your additions should produce the same kind of coherent story. If your new code scatters a concept across unexpected locations, that is the signal to rethink where it landed before committing.

This test is the meta-diagnostic. A codebase that passes the grep test is navigable. One that fails it will break the other principles even when they are technically followed.

---

## 1. File Size Signals Role

### Observation

Across well-organized codebases, file sizes cluster into distinct populations with very little in between. The bands are not arbitrary — each band corresponds to a kind of work the file is doing.

| Role | Typical Size (lines) | What It Does |
|------|----------------------|--------------|
| Barrel index | 1–11 | Re-exports the public surface of a folder. No logic. |
| Single-operation unit | 12–50 | Performs one operation. One tool, one purpose. |
| Domain manager | 50–200 | Holds or coordinates state for one domain concept. |
| Complex stateful module | 200–700 | Manages non-trivial state with multiple operations. |
| Protocol adapter | 500–1100 | Translates between an external protocol and the system's internal model. |
| Stateful distributed infrastructure | 1000+ | Coordinates state across processes, queues, or databases. |
| Orchestrator / composition root | 1000+ | Wires the system together or runs the central loop. |

The gaps between bands matter. A file at 280 lines is suspicious — it is past the manager band but below the complex stateful band. It is probably doing two things that should be split. A file at 1,200 lines is either an orchestrator (legitimate) or a manager that grew out of control (illegitimate). Size alone tells you which question to ask.

### Principle

**Principle.** File size is a signal of role, not a measure of quality. The soft ceiling for non-orchestrators is approximately 200 lines. Past that, a file is a candidate for extraction unless it falls into one of four exempt categories: composition root, central orchestrator, single-protocol adapter, or stateful distributed infrastructure where coordination complexity is real and cannot be arbitrarily decomposed. The test for legitimacy: does decomposing this require inventing a boundary that does not exist in the domain? If yes, the size is justified.

### Translation

Line count thresholds shift by language density. Python and Ruby are denser than Java; Rust is denser than Go; TypeScript sits in the middle. Adjust the bands by roughly 30% in either direction for languages at the extremes — but the shape of the distribution (distinct populations with gaps between them) holds in every language.

### Failure Mode

A codebase where file sizes form a smooth continuum from 50 to 800 lines, with no clear bands, is one where roles are not being thought about. Files grow until somebody happens to notice and split them, rather than being split when their role changes.

### Diagnostic

Run `find . -name '*.{ext}' | xargs wc -l | sort -n` and look at the distribution. If you see clear bands matching the table above, the codebase has structural discipline. If you see a smooth slope, it does not.

---

## 2. Index Files Have Two Valid Shapes

### Observation

The same filename — `index.ts`, `__init__.py`, `mod.rs` — appears throughout a codebase in two completely different roles. One is tiny. One is the largest file in the project. Both are correct.

A barrel index is 1–11 lines. It re-exports the public surface of its folder. It contains no logic. Its only job is to give consumers a single import target so the folder's internal layout can change without breaking anyone.

A composition root is 1,000+ lines. It is the file that wires the entire system together — instantiating dependencies, configuring registries, registering capabilities, starting the runtime. It is large because it has to know about every module in order to compose them.

These look like opposites. They share a filename because they share a role at the level of folder semantics: both define "what this folder exposes to the outside world." The barrel exposes a public API. The composition root exposes a wired-up system. The size tells you which one you are reading.

### Principle

**Principle.** The conventional folder-entry filename has two valid shapes, and they look opposite. A barrel index is small and contains only re-exports. A composition root is large and contains the wiring of the system. Do not measure either by the standard for the other. A 600-line `index.ts` that is a composition root is correct. A 600-line `index.ts` that is supposed to be a barrel is broken.

### Translation

| Language | Barrel filename | Composition root filename |
|----------|----------------|--------------------------|
| TypeScript / JavaScript | `index.ts` / `index.js` | `index.ts` (typically `src/index.ts`) |
| Python | `__init__.py` | usually a top-level `main.py` or `app.py` |
| Rust | `mod.rs` (or `lib.rs` for crates) | `main.rs` or `lib.rs` |
| Go | not idiomatic — packages export by capitalization | usually `main.go` or `cmd/{name}/main.go` |
| Java / Kotlin | not idiomatic — packages export via public modifier | typically a `@Configuration` class or `Application.java` |

Languages without an idiomatic barrel concept (Go, Java) substitute access modifiers and package boundaries. The composition root concept exists in all of them.

### Failure Mode

A "medium-sized" index file — 100 to 400 lines — is almost always wrong. It is too big to be a clean barrel and too small to be a composition root. Usually it means logic has leaked into a barrel, or the composition root has been partially extracted but not finished. Either way, fix it.

### Diagnostic

For every index file in the codebase, ask: is this a barrel (under 50 lines, only re-exports) or a composition root (over 1,000 lines, wires the system)? If it is neither, it is a problem.

---

## 3. Folder Organization — Domain Owns the Folder

### Observation

In well-organized codebases, top-level folders fall into two categories: domain folders and structural anchors.

Domain folders are named for what the system does. They contain everything related to that domain — implementation files, sub-adapters, the domain's own index. A domain folder is self-contained: you should be able to understand the domain by reading the folder, without jumping elsewhere.

Structural anchors are named for what kind of code lives inside them, not what it does. `types/`, `utils/`, `cli/`, `config/`. They exist at the top level only, as orientation points for the whole tree. They do not appear inside domain folders.

```
src/
  capabilities/        ← domain folder: contains everything about capabilities
    filesystem/
    git/
    permissions.ts
    registry.ts
  channels/            ← domain folder
  memory/              ← domain folder
  types/               ← structural anchor (top level only)
  utils/               ← structural anchor (top level only)
```

The rule that holds in working codebases: domain logic does not leak into structural folders, and structural folders do not appear inside domain folders. A `types/` directory inside `capabilities/` is the root structure leaking downward. It breaks the principle that the domain folder owns everything about the domain.

### Principle

**Principle.** Domain concepts own their folder end-to-end — implementation, sub-adapters, the folder's own index, and any domain-specific managers. Cross-cutting technical utilities are centralized at structural anchors at the top level only. Do not scatter utility concerns into domain folders, and do not let domain logic leak into utility folders. If a sub-domain needs its own types, those types live in `types.ts` inside the sub-domain — not in a nested `types/` folder that mirrors the root structure.

### Translation

This is purely a directory structure principle and is identical across languages. The only translation is which folder names count as "structural" — every codebase has its own set, but they all share the property of being named for the kind of code rather than what it does.

| Language ecosystem | Common structural anchor names |
|--------------------|-------------------------------|
| TypeScript / Node | `types/`, `utils/`, `lib/`, `config/`, `cli/` |
| Python | `utils/`, `helpers/`, `_internal/` |
| Rust | rare — Rust prefers mod boundaries with explicit `pub` |
| Go | rare — Go prefers flat packages |
| Java | `util/`, `config/`, `common/` |

Languages that prefer flat structure (Go, Rust) often skip structural anchors entirely. That is also valid — what matters is consistency.

### Failure Mode

The flat catch-all folder is the universal failure mode. Every codebase accumulates one. It starts as `utils/` with three files. After two years it has 80 files and nobody knows what is in it. When a flat folder reaches roughly 20 files, it is signaling that sub-domain grouping was skipped. The fix is to extract sub-domains: `utils/string-helpers.ts`, `utils/date-helpers.ts`, `utils/url-helpers.ts` become `utils/string/`, `utils/date/`, `utils/url/`. The presence of an out-of-control utility folder is the counterexample that validates the principle.

### Diagnostic

Look at every folder more than two levels deep. For each, ask: does its name describe a domain concept (what the system does) or a code category (what kind of code is inside)? The deeper a folder is, the more its name should be a domain concept. Code categories at depth are leakage.

**The non-engineer test:** say the folder name aloud to someone who understands the product but has never seen the code. Would they know what is in it? `capabilities` passes. `utils` fails. `memory` passes. `helpers` fails. `channels` passes. `common` fails. A name that a domain owner cannot interpret is either a structural anchor (valid at inflection points only) or a violation. This test catches violations the technical framing misses — it is possible to write a technically correct folder name that is still semantically empty in the domain.

---

## 4. Naming Specificity Increases With Depth

### Observation

The character of folder names changes as you descend the tree:

| Depth | Character | Examples |
|-------|-----------|---------|
| Root | Mixed: domain + structural anchors | `apps/`, `packages/`, `src/`, `types/`, `utils/` |
| Level 2 | Domain concepts | `run-engine/`, `capabilities/`, `soul/`, `memory/` |
| Level 3 | Convention inflection | `src/`, `test/`, `v3/` |
| Level 4+ | Domain again, narrowing toward operations | `waitpoints/`, `filesystem/`, then `read-file/` |

Structural anchors (`types/`, `utils/`, `src/`) do not appear at arbitrary depths. They cluster at orientation points: the root, and at convention inflection points where one organizational scheme transitions to another (a monorepo's `packages/{name}/src/` boundary, for example). Between those inflection points, every folder is named for a domain concept.

By the time you reach the leaves, names are operations: `read-file`, `cancel-task`, `git-commit`. Operations are the most specific names — they describe a single verb applied to a single noun.

### Principle

**Principle.** Naming specificity increases with depth. Structural anchors orient the tree at inflection points; domain names carry meaning everywhere else. The rule is not "structural anchors at root only" — it is "structural anchors at inflection points only, never inside a domain folder." A domain name must appear within two levels of any structural anchor. By the time you reach the leaves, names should be operations.

### Translation

This applies identically in any language. The only thing that changes is what counts as an "inflection point":

- Monorepos have inflection points at every `packages/{name}/` boundary.
- Multi-language repos have inflection points at every language boundary (`backend/`, `frontend/`, `infra/`).
- Library + binary repos in Rust have an inflection at `src/lib.rs` vs `src/bin/`.
- Framework-imposed structure (Django apps, Rails engines) creates inflection at every framework-required boundary.

Within each section between inflection points, the depth-vs-specificity rule applies fresh.

### Failure Mode

The classic violation is `src/types/user/types.ts` — a `types/` structural anchor inside the root `src/`, then a domain folder, then another `types/` inside the domain. The second `types/` is the root structure leaking downward. The fix is `src/types/user.ts` (if the type is a top-level shared type) or `src/user/types.ts` (if the type is internal to the user domain).

### Diagnostic

Pick any folder in the codebase. Ask: is its name a domain concept, a structural anchor, or a convention inflection? If structural anchor, is it at the root or an inflection point? If neither, it is misplaced.

---

## 5. File Naming — Verb-Noun For Operations, Noun For Holders

### Observation

Across well-organized codebases, two file-naming patterns appear consistently regardless of language:

- **Verb-noun** (in the language's preferred casing) for files that perform one operation: `read-file`, `cancel-task`, `git-commit`, `send-message`, `create-checkpoint`, `fetch-url`.
- **Noun** for files that hold or manage state: `permissions`, `registry`, `scheduler`, `lifecycle`, `identity`, `blocklist`.
- **Role names** for structural files: `index`, `types`, `base`, `constants`.

The principle underneath: a file's name should encode its role. A file that does one thing is named for what that thing is — verb plus noun. A file that holds or manages something is named for what it holds. A file that fills a structural role gets a role name.

### Principle

**Principle.** File naming follows the same rule as function naming. Files that perform one operation get a verb-noun name. Files that hold or manage state get a noun name. Files that fill a structural role get a role name. When a runtime boundary exists (server vs client, trusted vs untrusted), suffixes can encode it — but only the dangerous side needs marking. This is language-agnostic; only the casing convention varies.

### Translation

| Language | Operation file | Holder file | Casing convention |
|----------|---------------|-------------|-------------------|
| TypeScript / JavaScript | `read-file.ts` | `permissions.ts` | kebab-case |
| Python | `read_file.py` | `permissions.py` | snake_case |
| Rust | `read_file.rs` | `permissions.rs` | snake_case |
| Go | `readfile.go` | `permissions.go` | flat lowercase |
| Java / Kotlin | `ReadFile.java` (one class per file) | `Permissions.java` | PascalCase |
| Ruby | `read_file.rb` | `permissions.rb` | snake_case |

The boundary suffix pattern (`.server.ts`, `.client.ts`) is a JavaScript ecosystem convention that emerged because the same file can run in two environments. Languages without that ambiguity do not need it. The principle (mark the dangerous side of a runtime boundary) translates to other contexts: `_unsafe.rs` modules in Rust, `internal/` packages in Go.

### Failure Mode

The most common violation is a file that does two operations and gets named for one of them, or worse, gets a generic name like `helpers.ts` or `utils.ts`. The fix is to split. If you cannot find a verb-noun name for the file, the file is doing more than one thing.

A second violation: an operation file named like a holder. `user.ts` that contains a function `createUser` is misnamed — it should be `create-user.ts`. The current name suggests it holds the user concept, when it actually performs one user-related operation.

### Diagnostic

Open any file and look at its exports. A verb-noun named file should export one primary operation. A noun-named file should export a class, an object, or a tightly related set of operations on the same state. A mismatch between the name and the exports is a signal that the file's role is unclear.

---

## 6. Close the Universe of Values

### Observation

Any concept with a fixed set of valid options gets a closed type — never a raw string, never a raw number. A state machine has a fixed set of states. A user role has a fixed set of values. A message direction is one of a few options. Each of these gets a type that says "the universe of valid values is exactly this set, and nothing else."

The mechanism varies by language. In TypeScript, it is a union type or a const enum. In Rust, it is a sum-type enum (which can carry payloads). In Python, it is a `Literal` type or an `Enum` class. In Go, it is iota constants with a typed wrapper. In Java, it is an enum class.

The principle underneath every mechanism is the same: when you have a closed set of options, the language should know it is closed. Then the compiler enforces exhaustiveness. Adding a new option flags every place that did not handle it. Misspelling an option fails at compile time, not runtime.

The asymmetric failure of magic strings is what makes them dangerous. `if (state === "thinkign")` does not fail until that branch runs in production with the misspelling never matching. `if (state === States.Thinking)` with a typo fails at compile time the moment you write it.

### Principle

**Principle.** Close the universe of values for any concept with a fixed option set. The language chooses the mechanism — enum, union type, sum type, sealed class, const map, algebraic data type. The principle is the same everywhere: no magic strings where a closed type can be used instead. When the authoritative source of valid values is external (a database schema, an API contract, a generated type), pin your application's constants to that source at compile time so drift between the schema and the code is impossible.

### Translation

| Language | Mechanism for closed value sets |
|----------|--------------------------------|
| TypeScript | Union types (`type State = 'a' \| 'b'`) or const enums |
| Python | `Literal['a', 'b']` for shape-checking, `Enum` class for behavior |
| Rust | `enum` (which is more powerful — variants carry data) |
| Go | Typed iota constants (`type State int; const ( StateA State = iota; StateB )`) |
| Java | `enum` class |
| Kotlin | `enum class` or `sealed class` (when variants need different shapes) |
| Swift | `enum` (similar to Rust — variants carry data) |
| C# | `enum` for simple, sealed class hierarchy for variant-with-data |

A subtle point: in some languages, the natural closed-type mechanism is more expressive than what TypeScript offers. Rust, Swift, Kotlin, and Scala all have sum types where each variant can carry its own payload. Use that capability — do not artificially flatten to a string-like enum just because that is what TypeScript would do.

### Failure Mode

The clearest sign of failure: comparing strings against literals scattered through the codebase. `if (status === "pending")` in seventeen files. The fix is to define `Status` as a closed type and have every site reference its values through the type.

A second failure: an enum exists, but values are also referenced as raw strings somewhere because "it was easier in this one place." That breaks the exhaustiveness guarantee. Either the enum is the only source of these values, or it is not the source at all.

### Diagnostic

Grep for string literals that look like states or roles or modes. If the same literal appears in more than two places without going through a typed constant, it is a magic string and it should be closed.

---

## 7. Classes Hold State and Lifecycle, Types Hold Shape

### Observation

In well-organized codebases, classes and type definitions have non-overlapping roles.

Classes are for things that have state and a lifecycle: a `Scheduler` that maintains a queue and ticks forward, a `PermissionManager` that holds a permission table and answers queries, a `ToolCallLoopDetector` that tracks recent calls. Classes are constructed once and live for some duration. They have methods that change their state or expose it.

Type definitions (interfaces, records, structs without methods) are for shapes: a `Message` has a sender, content, and timestamp; a `User` has an id, name, and email; a `Config` has a set of fields. Shapes are passive — they describe data, they do not do anything.

Abstract bases (or their language equivalents) are for adapter contracts: `ProviderBase` declares what every provider must do; concrete subclasses implement it for OpenAI, Anthropic, etc.

These three roles do not mix. A type definition with methods on it is a class in disguise. A class without state is just a namespace and probably should be a module of functions. An abstract base with concrete behavior is doing two jobs.

### Principle

**Principle.** Classes are for state and lifecycle. Type definitions are for shapes. Abstract bases are for adapter contracts. These three roles do not mix, regardless of language. If you find a "class" with no state and only static methods, it is a module of functions and should be one. If you find a "type" that contains behavior, it is a class and should be one.

### Translation

| Language | "State + lifecycle" | "Pure shape" | "Adapter contract" |
|----------|--------------------|--------------|--------------------|
| TypeScript | `class` | `interface` or `type` | `abstract class` or `interface` |
| Python | `class` with state | `dataclass` or `TypedDict` | `abc.ABC` |
| Rust | `struct + impl` | `struct` (no impl, or only derived traits) | `trait` |
| Go | `struct + methods` | `struct` (fields only) | `interface` |
| Java | `class` | `record` (Java 14+) or POJO | `abstract class` or `interface` |
| Kotlin | `class` | `data class` | `abstract class` or `interface` |
| Swift | `class` (reference) or `struct` (value) with state | `struct` (value, no behavior) | `protocol` |

A note on Rust and Go: these languages collapse "class" and "shape" into one concept (struct). The role distinction is enforced by whether the struct has an `impl` block (Rust) or methods (Go). A struct with no methods is a shape; a struct with methods is the class equivalent. Same principle, different syntactic surface.

### Failure Mode

The most common violation is a "manager" class that holds no state, or a "service" class with only static methods. These are modules of functions wearing a class costume. The fix in object-oriented languages is to convert to a module of free functions; in languages without modules (Java pre-records), use a `final` class with a private constructor and accept that the language is making you wear a costume.

A second violation: putting methods on a record/struct/interface that should be a pure shape. The methods belong on a class that operates on the shape, or as free functions that take the shape as a parameter.

### Diagnostic

For every class in the codebase, ask: what state does it hold, and what is its lifecycle? If the answer is "no state, lives forever," it should be a module. For every type with methods, ask: should this be a class? If the methods change something, the answer is yes.

---

## 8. The Composition Root

### Observation

Every system has a place where everything wires together: dependencies are constructed, registries are populated, capabilities are registered, the runtime starts. In well-organized codebases, this place is explicit, singular, and visible. There is exactly one file that knows how all the pieces fit together. Every other file only knows what it was given.

The composition root is the entry point of the application from the perspective of object construction. Other files do not construct their own dependencies. They do not reach sideways into other modules. They receive what they need as parameters or constructor arguments. The composition root is the only place that imports from every domain.

This is what makes domain modules independently testable. A `Scheduler` that constructs its own database connection can only be tested with a real database. A `Scheduler` that receives a database connection can be tested with a fake one — the composition root passes a real one in production and a fake one in tests.

### Principle

**Principle.** All construction and wiring of modules happens in one place. Every module receives its dependencies — nothing builds itself, nothing reaches sideways into another module. The composition root is the only place that knows how the system assembles. Every other file only knows what it was given. If you want to understand how a system is put together, there is exactly one file to read.

### Translation

| Pattern | Composition root form |
|---------|----------------------|
| Manual wiring (TypeScript, Python, Rust, Go) | A single file that imports and instantiates every module, in dependency order |
| Dependency injection container (Spring, Angular, .NET) | The DI configuration is the composition root — written declaratively rather than imperatively |
| Framework-managed (Rails, Django) | The framework owns the composition root; your config files extend it |
| Compile-time DI (Dagger, Wire) | The generated wiring code is the composition root |

A point of confusion: in framework-heavy environments, it can look like there is no composition root because you never wrote one. The composition root is still there — the framework wrote it. You configure it through the framework's mechanism. The principle still holds: there is one place that knows how things are wired, and that place is the framework's configuration.

### Failure Mode

The classic violation is service location: modules ask a global registry for their dependencies at the moment they need them, rather than receiving them at construction time. This pushes the wiring decisions out of the composition root and scatters them across every module. Each module becomes harder to test because you have to mock the global registry.

A second violation: partial composition. The composition root constructs some dependencies but lets others construct themselves. This produces a codebase where some modules are testable and others are not, with no obvious rule for which is which.

### Diagnostic

Try to find the composition root by reading the codebase. If you can find it in under five minutes by following imports from `main` (or the language equivalent), the principle is being followed. If the wiring is spread across many files with no single owner, it is not.

---

## 9. Schema Enforcement Lives At Boundaries

### Observation

Inside a trusted process, types are sufficient. The compiler (or runtime type checker) ensures that data has the shape you expect. There is no need for runtime validation when nothing untrusted can enter.

At external boundaries, types are not enough. An HTTP request body is a blob of JSON until something parses it. A database row is a blob of bytes until something interprets it. A queue message is a blob until something deserializes it. At each of these boundaries, you need runtime enforcement: a schema that validates the data conforms to its declared shape, and rejects it explicitly if it does not.

The pattern that holds in well-organized codebases: every place where untrusted data enters has a schema. Internal code passes typed objects; external boundaries parse and validate. The TypeScript type used internally is derived from the schema, not maintained separately — that way they cannot drift.

Two works named this principle before it became common practice. **"Parse, Don't Validate"** (Alexis King, 2019) argues that the goal is not to check whether data is valid and proceed — it is to transform untrusted data into a typed value that the rest of the system can use without rechecking. If parsing fails, execution stops at the boundary; invalid data cannot propagate because it never acquires a type that permits it to. **"Domain Modeling Made Functional"** (Scott Wlaschin) extends this: model your domain types so that invalid states are unrepresentable, not just checked. The schema is not a validator bolted on — it is the definition of what it means to be a valid value.

### Principle

**Principle.** Runtime schema enforcement belongs at external boundaries only. Inside a trusted process, types are sufficient. At every HTTP, queue, database, file, or external-API boundary, a runtime schema is required. Derive the in-process type from the schema (one source of truth) so the type and the schema cannot drift apart. Inside the trusted process, do not double-validate — the boundary already did it.

### Translation

| Boundary | Validation mechanism varies by stack |
|----------|-------------------------------------|
| HTTP request body | Zod (TS), Pydantic (Python), serde + validator (Rust), Jackson + Bean Validation (Java) |
| Database row | ORM type generation pinned to schema (Prisma, SQLAlchemy with mypy, Diesel, jOOQ) |
| Queue message | Schema registry (Avro, Protobuf) or runtime validation library |
| Config file | Same validation library as HTTP, applied at startup |
| External API response | Same validation library as HTTP, applied at the SDK or HTTP client boundary |

A subtle point: some languages have already done this work in the type system. Rust's `serde` rejects malformed input at deserialization time, with the error path explicit. Haskell's `aeson` does the same. In those languages, the "schema" is the struct definition itself, and there is no separate validation step — the deserialize call is the validation.

**The parse-transform-persist pattern** names the four shapes data moves through in a well-organized system:

- **Raw** — the untrusted external input: a JSON body, a database row before validation, a queue message as bytes.
- **Parsed** — schema-validated and typed: what the boundary schema produces on success.
- **Domain** — the internal type the business logic operates on: may differ from the parsed shape if the external API and the domain concept have different structures.
- **Persisted** — the shape the storage layer writes and reads, generated from the storage schema.

When variables are named for their layer (`rawUserInput`, `parsedUser`, `domainUser`, `persistedUser`), the type dissolution check becomes trivial to run — you can see exactly where a value crossed a layer boundary and whether it was validated before it did.

### Failure Mode

The classic violation is trusting the type checker for external data. A TypeScript handler that does `const body: UserInput = await req.json()` has just lied to the compiler. The compiler now believes the body has the `UserInput` shape, but nothing has actually checked. A malformed request will produce a runtime error somewhere deep in the handler, not at the boundary.

A second violation: double validation. Validating at the HTTP boundary, then validating again inside the service, then validating again before the database write. This is defensive programming hiding the absence of clear boundaries. Pick the boundary, validate there, and trust the data afterward.

### Diagnostic

For every external entry point in the codebase, ask: what runs first, when the data is still untrusted? If the answer is "nothing — we just cast the body to a type," the boundary is unenforced. If the answer is "a schema parses the body and rejects it on failure," the boundary is correct.

---

## 10. Code Is the Documentation

### Observation

In well-organized codebases, the things that can be encoded in code are encoded in code, and the things that cannot be encoded in code are documented separately. The line between the two is sharp.

Code that documents itself: types, names, structures, signatures, schemas, enums, file organization. These cannot drift, because the compiler or runtime catches drift immediately. A function signature `(rawInput: FormData) => ValidatedOrder` tells you exactly what the function does at the level of data flow — untrusted in, validated out. A folder named `capabilities/git/git-commit.ts` tells you exactly what the file is.

Things that cannot be encoded in code: design rationale, decisions taken, architectural boundaries, what the system deliberately does not do. These get documented in two places — and only two:

- A living architecture document that describes the current state of the system. Updated when the system changes. Declares itself living at the top.
- A decision log (ADR-style) that records why decisions were made. Append-only. Never rewritten. Each entry is a timestamp of what was known at the time.

Inline comments are minimal in well-organized codebases. The healthy ratio of architectural documentation to code is around 3% by volume. Inline comments are close to zero. When names and types are doing their job, an inline comment usually means the structure was not clear enough — and the fix is to make the structure clearer, not to add a comment.

### Principle

**Principle.** When names and types are doing their job, inline comments are a smell. The healthy codebase carries its documentation in three places: the code itself (compiler-enforced), a living architecture document (3% of code volume), and an append-only decision log (one entry per contested, non-obvious, or load-bearing decision — not one per feature). Code documents the what; the architecture doc documents the now; the decision log documents the why.

### Translation

This principle is language-agnostic. The mechanisms differ slightly by language:

- Strongly-typed languages (Rust, Haskell, TypeScript with strict mode) get the most leverage from "code is documentation" because the compiler catches more.
- Dynamically-typed languages (Python, Ruby) need to lean harder on naming and structure, since the compiler cannot enforce types. Type hints and dataclasses recover most of the leverage.
- Languages with weak type systems (Go) compensate by leaning hardest on naming. Go's convention of short, role-encoding names is doing the work that types do in other languages.

The decision log format (ADR — Architecture Decision Record) is language-agnostic and tooling-agnostic. Each entry is a markdown file with exactly three sections:

- **Context** — what situation prompted the decision, what constraints existed, what was known at the time.
- **Decision** — what was decided. One clear sentence.
- **Consequence** — what the decision makes easier, what it makes harder, what is now off the table.

The title is the verdict, not the topic. "Daemonization via custom hybrid approach" is a verdict — it tells you the outcome. "Daemonization" is a topic — it tells you nothing. The title should let a reader scan a list of ADRs and understand the shape of the system without opening any entry.

The log is append-only. Entries are never rewritten. When a decision is reversed, a new entry records the reversal. The old entry stays — it is a timestamp of what was known and decided at that moment. The log lives in the repository, not in an external wiki. A `DECISIONS.md` at the root, or a `docs/decisions/` folder with one file per entry, are both valid.

### Failure Mode

The clearest failure mode: a codebase with extensive inline comments explaining what each function does. This means the names and signatures are not carrying their weight. The fix is not to remove the comments — it is to rename and restructure so the comments become unnecessary, then remove them.

A second failure: a wiki or external doc system that drifts from the code. Whenever architectural docs live outside the repo, they go stale. Architectural docs belong in the repo, in markdown, alongside the code they describe.

A third failure: a decision log that records every change, not every contested decision. The log loses signal — readers stop opening it because most entries are routine. The log should be sparse: roughly one decision per 1,000–1,500 lines of code is the healthy density.

### Diagnostic

Open three random files. Count inline comments. If the ratio is more than one comment per 50 lines (excluding doc comments on public APIs), names are not pulling their weight. Then look for the architecture doc. If it does not exist, or if it does not declare itself living, the codebase has no current-state documentation — every reader is reverse-engineering it from scratch. Finally, find the decision log. Does it exist? Count its entries and divide by the total source line count (in thousands). A density of roughly 1 entry per 1,000–1,500 lines is healthy. Below that, decisions are undocumented and you will be reverse-engineering rationale. Above it, the log is recording routine changes rather than contested decisions, and it will stop being read.

---

## 11. Tests Mirror the Source

### Observation

Tests are organized in one of two ways across well-organized codebases: mirrored (a parallel `tests/` tree that matches `src/`) or co-located by language convention (Rust's `#[cfg(test)] mod tests` inside the file, Go's `foo_test.go` next to `foo.go`).

Both can work. The mirror approach is preferred when the language does not have an idiomatic co-location pattern, because the alternative (scattered `__tests__/` folders inside domain folders) pollutes the domain with test noise. The co-located approach is preferred in languages that built tooling around it.

What is not acceptable in either model: scattering test files inside domain folders without a convention. `src/estimates/calculator.ts`, `src/estimates/calculator.test.ts`, `src/estimates/__tests__/calculator.spec.ts`, all coexisting with no rule, is the failure pattern. The domain folder ends up with as much test code as production code, and the production code becomes hard to read.

The principle underneath: tests should be discoverable and segregated. An agent reading domain code should not be tripping over test files. An agent looking for tests should know where to find them.

### Principle

**Principle.** Tests live in a structure parallel to the source — either mirrored (separate top-level `tests/` tree matching `src/`) or co-located by strong language convention (Rust modules, Go `_test.go`). The domain folder stays pure. Test artifacts (snapshot baselines, golden masters, fixtures) live with the tests, not the source. Three folder roles, when they exist, are kept distinct: spec files (the assertions), module stubs (fakes), and shared helpers (reused setup that is neither spec nor stub).

### Translation

| Language | Idiomatic test layout |
|----------|-----------------------|
| TypeScript / JavaScript | Mirror (`tests/` tree) or co-located (`*.spec.ts`); both are common |
| Python | Mirror (`tests/` tree at root) is most common |
| Rust | Co-located (`#[cfg(test)] mod tests` in source file) for unit; `tests/` tree for integration |
| Go | Co-located (`foo_test.go` next to `foo.go`) is the convention; mirror is non-idiomatic |
| Java / Kotlin | Mirror (`src/main/java/...` and `src/test/java/...` parallel trees), enforced by Maven/Gradle |
| Ruby | Mirror (`spec/` tree mirrors `lib/`) |

The "mirror vs co-locate" choice is downstream of language conventions. Fight your language's conventions and you produce a codebase that fights its tooling. Match your language's conventions and the tooling does most of the work.

### Failure Mode

The most common violation is inconsistent placement. Some tests are co-located, some are in `__tests__/`, some are in `tests/` at the root. There is no rule. The fix is to pick one convention and apply it everywhere — accepting some short-term churn to move existing tests.

A second violation: mixing spec files, mock files, and helper files in the same folder without distinguishing them. A folder with `user.spec.ts`, `user-mock.ts`, `test-setup.ts` all together is harder to navigate than the same folder with `__tests__/`, `__mocks__/`, `__test-utils__/` segregating them by role.

### Diagnostic

Pick a source file at random and try to find its tests in under 30 seconds. If you can, the convention is working. If you cannot, it is not.

---

## 12. Observability — Typed Results, Not Naked Exceptions

### Observation

Bad agentic code is code where the agent cannot see what is happening. Good code makes its behavior visible at every boundary: every operation has a typed outcome, every error carries context, every response is traceable.

The pattern that holds in well-organized codebases: operations return typed results that explicitly carry both success and failure paths, rather than throwing naked exceptions for routine failure cases. Exceptions are reserved for genuinely exceptional conditions — programmer error, infrastructure failure, things the application cannot recover from. Routine failures (validation rejections, missing records, permission denials) are values, not exceptions.

```typescript
type OperationResult<T> =
  | { success: true; data: T }
  | { success: false; error: ErrorCode; message: string }
```

This is the Rust `Result<T, E>` pattern, which has spread across languages because it works. The caller cannot ignore the failure case — the type system forces them to handle it. Logs at the boundary capture every result. Errors include the context of what was being attempted, not just a message.

### Principle

**Principle.** Every operation returns a typed result that explicitly carries both success and failure paths. Exceptions are reserved for genuinely exceptional conditions — bugs, infrastructure failures, conditions the application cannot recover from. Every response is logged before it is returned. Every exception carries the full context of what was being attempted, not just an error message. From any endpoint or boundary, the four questions — what comes in, what goes out, what can go wrong, what message the user sees — must be answerable from a single file.

### Translation

| Language | Result type pattern |
|----------|-------------------|
| Rust | `Result<T, E>` is the language default — built in |
| Haskell, OCaml, F# | `Either` / `Result` types — language idiomatic |
| TypeScript | Discriminated union: `{ ok: true; value: T } \| { ok: false; error: E }` |
| Python | `dataclass` with `success: bool`, or a Result library |
| Go | The `(value, error)` return tuple is the language idiom — same principle, different syntax |
| Java | `Optional<T>` for absence; Either libraries (Vavr) for results; or sealed result classes |
| Kotlin | `Result<T>` built into the standard library; sealed classes for richer error types |
| Swift | `Result<Success, Failure>` built in |

The Go convention `(value, error)` is the same principle as a Result type — the caller must handle the error explicitly because it is in the return position. Languages without first-class result types build them as libraries or as sealed class hierarchies.

### Failure Mode

The classic failure: throwing for control flow. Throwing an exception when a user is not found, when a form fails validation, when permissions are insufficient. These are routine outcomes, not exceptions. The fix is to return a typed result that the caller must handle.

A second failure: error messages without context. `throw new Error("Not found")` tells you nothing. `throw new Error("User not found: id=42, queried by handler=getUserProfile")` tells you what was being attempted, against what data, where in the system.

A third failure: opaque endpoints. An endpoint where you have to read five files to understand its inputs, outputs, error cases, and user-facing messages. The endpoint is not a complete unit.

### Diagnostic

Pick any endpoint or boundary function. Without leaving the file, can you answer: what comes in, what goes out, what can go wrong, what message does the user see? If yes, the boundary is observable. If no, observability is broken.

---

## The Diagnostic Battery

When approaching an unfamiliar codebase, run these checks before touching anything. They take five minutes and tell you how much you can trust the structure.

**The grep test.** Pick a core domain concept (e.g., `User`, `Order`, `Capability`). Grep for it. Do the results tell a coherent story — origin, transformation, consumption? If yes, the concept is well-named and well-located. If you find nothing, the concept was never named (it lives implicitly in scattered code). If you find 400 results, the name is too generic to carry meaning.

**The type dissolution check.** Follow data from an entry point through the system. Does it keep its type identity, or does it dissolve into `any`, anonymous destructuring, or generic object somewhere mid-journey? The moment the type dissolves, the thread breaks — and so does the agent's ability to follow what is happening.

**The size distribution check.** List file line counts and sort them. Do they form distinct bands matching the role table in §1, or a smooth slope from small to large? Bands mean role-aware splitting. Smooth slope means files grow until someone notices.

**The structural anchor check.** Find every folder named `types/`, `utils/`, `helpers/`, or similar. Are they all at structural inflection points (root, monorepo package boundaries, language boundaries)? If you find one nested inside a domain folder, the root structure has leaked downward.

**The composition root check.** Try to find the single file that wires the system together. If you can find it in under five minutes by following imports from `main`, the principle is being followed. If wiring is spread everywhere with no central owner, it is not.

**The boundary check.** Pick three external entry points (HTTP routes, queue consumers, file readers). For each, find what runs first when the data is still untrusted. If a schema validation runs first, the boundary is enforced. If the data is cast to a type without checking, the boundary is a lie.

**The endpoint drillability test.** Pick any endpoint. Without leaving the file, can you answer: what comes in, what goes out, what can go wrong, what message does the user see? Four questions, one file. If you need five files to answer, the endpoint is not a complete unit.

**The variable name audit.** Open three files at random. Are variables named for domain role (`databaseSchemaResponse`, `validatedSchema`, `rawApiPayload`) or technical type (`data`, `res`, `obj`, `tmp`)? Generic names mean the naming principle was never applied — and you cannot trust any other principle either, because they all depend on names doing their work.

**The decision log check.** Find the architectural decision log. Does it exist? If yes, what is the density (decisions per thousand lines of code)? Density of roughly 1 per 1,000–1,500 lines is healthy. Much more is over-documentation; much less means decisions are undocumented and you will be reverse-engineering them.

---

## How To Apply This Guide

If you are an agent reading this before working in a codebase, apply the guide in this order:

**First,** run the diagnostic battery. This is observation, not modification. You are calibrating how much you can trust the existing structure. A codebase that passes most checks lets you follow its conventions confidently. A codebase that fails most checks means you cannot trust the structure to guide you — you have to apply the principles fresh.

**Second,** identify the language and framework constraints. Some principles translate directly (file size signals role). Some require translation (verb-noun for operations, with the language's casing convention). Some are subsumed by frameworks (composition root in a Spring application is the DI container, not a hand-written file). Do not fight the language. The principles are inputs to your decisions; the language's idioms determine the form those decisions take.

**Third,** when adding new code, ask the questions in order:

1. What is the role of the file I am about to create — operation, holder, structural? (§5)
2. What domain does it belong to — which folder owns it? (§3)
3. What is the appropriate size band for this role? (§1)
4. Are there closed sets of values it deals with — do they have closed types? (§6)
5. Does it have state and lifecycle, or is it a pure shape? (§7)
6. If it is at an external boundary, what schema validates the input? (§9)
7. Does it return typed results, or does it throw for control flow? (§12)

**Fourth,** when modifying existing code, respect what is already there. If the codebase uses `snake_case` file names, do not introduce `kebab-case`. If the codebase uses a service-locator pattern instead of constructor injection, fixing it is a separate refactor — do not mix it into a feature change. The principles are most useful for new code. Existing code carries the decisions of its authors; respect that, even when those decisions disagree with this guide.

**Fifth,** when something feels wrong, name what is wrong using the vocabulary in this guide. "This file is 600 lines and is not an orchestrator" (§1). "This is a structural anchor inside a domain folder" (§3). "This is throwing for a routine failure" (§12). Naming the violation makes it discussable. Vague unease is not actionable; a named principle violation is.

**Sixth,** after adding any code, run the grep test on your new concepts. Pick the domain nouns you introduced and grep for them. The results should tell a coherent story — your additions clustering in expected locations, extending an existing pattern rather than scattering a new one. If a concept you introduced appears in too many places, or appears nowhere (meaning you used inline strings instead of a named type), those are the signals to correct before finishing. The grep test opened the work; close it with the same test.

---

## The Abstract Principles

Distilled from all twelve sections:

1. **File size signals role.** Primitives are small. Orchestrators are large. Non-orchestrators past ~200 lines are split candidates. Exempt: composition roots, orchestrators, protocol adapters, stateful distributed infrastructure.
2. **Index files have two valid shapes.** A barrel re-export is small. A composition root is large. Size tells you which one you are reading.
3. **Domain concepts own their folder.** Cross-cutting technical utilities are centralized at structural anchors at the top level only. The flat catch-all folder is the universal failure mode.
4. **Naming specificity increases with depth.** Structural anchors at inflection points only. Domain concepts everywhere else. Operations at the leaves. A domain name must appear within two levels of any structural anchor.
5. **Verb-noun for operations, noun for holders.** The function naming rule applies to files. Suffixes can encode boundary type — but only the dangerous side needs marking.
6. **Close the universe of values.** Language chooses the mechanism. The principle is the same everywhere: no magic strings for concepts with fixed option sets.
7. **Classes hold state and lifecycle. Types hold shape. Abstract bases hold contracts.** These three roles do not mix, regardless of language.
8. **The composition root is singular and explicit.** All wiring happens in one place. Every other module receives its dependencies. Nothing reaches sideways.
9. **Runtime schema enforcement at external boundaries only.** Inside a trusted process, types are sufficient. At every HTTP, queue, database, or external-API boundary, a runtime schema is required.
10. **Code documents what; the architecture doc documents now; the decision log documents why.** Inline comments are a smell. Architectural documentation sits around 3% of code volume. The decision log records contested decisions, not features.
11. **Tests live in a structure parallel to the source.** Mirror or strong language convention. The domain folder stays pure. Spec files, mock files, and shared helpers are kept distinct.
12. **Operations return typed results, not naked exceptions.** Routine failures are values. Exceptions are reserved for genuinely exceptional conditions. Every boundary is observable from a single file.

These twelve principles are language-agnostic. The implementations are not. Translate the implementation to your language's idioms; keep the principle intact.

---

## Appendix A — Injectable Agent Primer

Copy this block verbatim into an agent brief when you want the agent to navigate or modify a codebase using this guide's principles. It is self-contained — no other section needs to be included.

---

You are about to work in a codebase. Before touching anything, run the grep test: pick a core domain noun (`User`, `Order`, `Capability`, `Task`) and grep for it. If results tell a coherent story clustered in well-named locations, follow the codebase's conventions. If results are scattered or absent, treat every principle below as potentially unapplied and apply them fresh.

**STRUCTURAL PRINCIPLES (language-agnostic):**

1. File size signals role. Barrel indexes are 1–11 lines. Single operations are 12–50. Domain managers are 50–200. Past 200 lines, a file is a split candidate unless it is a composition root, orchestrator, single-protocol adapter, or stateful distributed infrastructure. The test for legitimacy: does decomposing this file require inventing a boundary that does not exist in the domain?

2. Index files have two valid shapes. A barrel index is small (under 15 lines) and contains only re-exports. A composition root is large (1,000+ lines) and wires the system together. A 600-line index that is neither is a problem.

3. Domain concepts own their folder end-to-end. Structural anchors (`types/`, `utils/`, `helpers/`) are valid only at inflection points: the project root, package roots, language boundaries. Never inside a domain folder. Types for a sub-domain live in `types.ts` inside the sub-domain — not in a nested `types/` subfolder.

4. Naming specificity increases with depth. A domain name must appear within two levels of any structural anchor. Leaf-level names are operations (verb-noun). If you are two folders deep from the root and have still not seen a domain concept, navigation is broken.

5. File naming follows function naming. Operation files use verb-noun (`read-file`, `cancel-task`). Holder and manager files use noun (`permissions`, `registry`, `scheduler`). Structural files use role names (`index`, `types`, `base`). Only the dangerous side of a runtime boundary needs a suffix (`.server.ts` exists; `.client.ts` does not).

6. Close the universe of values. Any concept with a fixed option set gets a closed type — enum, union type, sum type, sealed class. No magic strings. If the same string literal appears in more than two places without going through a typed constant, close it.

7. Classes hold state and lifecycle. Type definitions hold shape. Abstract bases hold contracts. A class with no state should be a module of functions. A type with behavior should be a class.

8. All construction and wiring happens in one place — the composition root. Every other module receives its dependencies. Nothing builds itself. Nothing reaches sideways.

9. Runtime schema enforcement belongs at external boundaries only. At every HTTP, queue, database, or external-API boundary, a schema validates and types the data. Inside the trusted process, types are sufficient — do not re-validate. Derive internal types from the schema so they cannot drift. Data moves through four named shapes: raw (untrusted blob) → parsed (schema-validated) → domain (internal type) → persisted (storage shape).

10. Code documents what. The architecture doc documents now. The decision log documents why. Inline comments are a smell — when names and types are doing their job, comments are unnecessary. The decision log (ADR format: Context / Decision / Consequence, title is the verdict) is append-only, lives in the repo, and records contested decisions at a density of roughly 1 per 1,000–1,500 lines of source.

11. Tests live parallel to source — mirrored tree or strong language convention. The domain folder stays pure. Spec files, fakes, and shared helpers are kept in distinct sub-folders.

12. Operations return typed results, not naked exceptions. Routine failures (missing record, permission denied, validation rejection) are values. Exceptions are reserved for bugs and infrastructure failures. From any endpoint, the four questions — what comes in, what goes out, what can go wrong, what message does the user see — must be answerable from a single file.

**WHEN ADDING CODE — ask in order:**

1. What is the file's role — operation, holder, structural? Name it accordingly.
2. Which domain owns it — which folder?
3. What size band is appropriate for this role?
4. Are there closed value sets? Define closed types.
5. Does it have state and lifecycle, or is it a pure shape?
6. Is it at an external boundary? What schema validates the input?
7. Does it return a typed result or throw for control flow?

After adding code, re-run the grep test on your new concepts. Your additions should cluster coherently. If a concept scatters across unexpected locations, reconsider where it landed before finishing.

**NAMING A VIOLATION — when something is wrong, name it:**

- "This file is 400 lines and is not an orchestrator." (principle 1)
- "This is a structural anchor inside a domain folder." (principle 3)
- "This index file is 300 lines — it is neither a barrel nor a composition root." (principle 2)
- "This is throwing for a routine failure case." (principle 12)
- "This string literal appears in eleven files without a closed type." (principle 6)
