# ADW — Building Blocks

The six named concepts that give a codebase persistent, greppable identity. Each one serves a different role in keeping the thread intact.

---

## Types

**What they are:** Compiler-level shape descriptions. The language the compiler uses to verify the journey.

**What they do:** Document data's journey in a form that is mechanically checked. A type shows where data is born (`User` from a DB row), how it transforms (`DatabaseUser` → `PublicUserDTO` — the exact moment `passwordHash` drops), where it crosses a boundary (`(rawInput: FormData) => ValidatedOrder` — untrusted in, validated out), and where it ends (`void` = data traveled no further).

**The discipline:** Declare return types on every function. Never allow implicit `any`. Every boundary crossing should change the type to reflect the new trust level.

**The failure mode:** Type dissolution — a typed value passes into a function and comes out as `any`, `unknown`, or a generic `Record`. Once dissolved, the compiler stops protecting you and bugs propagate silently.

---

## Structures

**What they are:** Named, defined shapes — the vocabulary of the system.

**What they do:** Give data a persistent identity as it travels. When you define `DatabaseSchemaResponse`, you coin a term. Every function that takes it speaks the same language without re-explanation.

**The discipline:** Names signal trust level and stage. `RawApiPayload` = untrusted, not yet validated. `ValidatedUserInput` = passed a schema. `DatabaseSchemaResponse` = came from the DB, is trusted. The name is not a description — it is a domain noun.

**The distinction from Types:** A structure is the named concept (`DatabaseSchemaResponse`). The type is its compiler-level shape — the fact that it has `tables: Table[]`. One is the name; the other is what's inside. Both matter.

**The failure mode:** Generic names — `data`, `response`, `obj`, `result`. These names carry no trust signal and break the grep test immediately.

---

## Schemas

**What they are:** Runtime enforcement. The gatekeeper at every entry point.

**What they do:** Validate untrusted data at the moment it enters the system. Raw external data either passes the schema and becomes a trusted, typed object — or fails immediately with a localized, explicit error. Without a schema, a malformed API response silently corrupts logic three layers deep. With one, failure is immediate and contained at the edge.

**The discipline:** One source of truth. Derive the TypeScript type from the schema so they cannot drift apart:

```typescript
const DatabaseSchemaResponseSchema = z.object({
  tables: z.array(TableSchema),
  version: z.string(),
})

type DatabaseSchemaResponse = z.infer<typeof DatabaseSchemaResponseSchema>
```

Never write the type and schema separately and hope they stay in sync.

**Where schemas belong:** At every point where untrusted data enters — API responses, database reads, file reads, user input, webhook bodies. If data crosses a trust boundary without a schema, that boundary is unguarded.

**The failure mode:** Schemas defined but never called at runtime (type-only, stripped at compile). The schema exists but `.parse()` or `.safeParse()` is never called at the actual entry point.

---

## Interfaces

**What they are:** Pure contracts — what something must do, with nothing about how.

**What they do:** Define the seam between layers. The caller doesn't know if `SchemaAnalyzer.findRelationships()` hits a live database or a mock. It only knows the promise. Strip a codebase to its interfaces and you have the purest map of what the system does — the skeleton without the flesh.

**The discipline:** Write the interface before the class. Asking "what does this layer promise?" before "how does it work?" forces clarity about responsibility. Every interface is also a seam — a deliberate door where implementations can be swapped without touching downstream callers.

**The failure mode:** Layers reaching directly into each other's implementations. No interface means no visible seam — you cannot grep to find where one concern ends and another begins, and nothing can be swapped without risk of breaking everything connected.

---

## Classes

**What they are:** Actors — verb-nouns that own both data and the behavior that operates on it.

**What they do:** Encode single responsibility in a searchable name. `DatabaseSchemaAnalyzer` doesn't just hold a schema — it owns `findRelationships()` and `generateMigrationPlan()`. That ownership is an architectural decision encoded in a name that survives grep.

**The naming rule:** Verb-noun pairs that state purpose. `DatabaseSchemaAnalyzer` analyzes. `MigrationPlanGenerator` generates plans. `SchemaChangeValidator` validates changes. A class named `Manager` or `Handler` tells you nothing — it is a responsibility black hole.

**The failure mode:** Responsibility scatter — the logic for a core operation is split across a utility file, a route handler, a helper, and a service. No single class owns it. Grep finds fragments, not the whole story.

---

## Enums

**What they are:** Closed universes. A complete, named set of valid values for a concept.

**What they do:** Eliminate magic strings, make valid inputs self-documenting at every call site, and force exhaustive handling. `SchemaChangeType.AddTable` cannot be misspelled — `"add_table"` can. Add a new enum value and the compiler flags every switch statement that didn't account for it.

**The discipline:** If a concept has a finite set of valid values, it is an enum. Define it once. Reference it everywhere. Never scatter the valid values across prose documentation, comments, or repeated string literals.

**The failure mode:** Valid values buried in prose (`COMPLETE | NEEDS_REVIEW | BLOCKED`), repeated across multiple files as string literals, with no single source of truth. A misspelled value passes silently. A new value requires hunting down every check.

---

## Summary

| Block | Role | Grep signal | Failure mode |
|-------|------|-------------|--------------|
| Types | Compiler-tracked journey | Return types, boundary crossings | Dissolution to `any` |
| Structures | Named domain vocabulary | Domain nouns survive grep | Generic names (`data`, `res`) |
| Schemas | Runtime trust enforcement | `.parse()` / `.safeParse()` at entry | Defined but never called |
| Interfaces | Layer contracts | Interface names at seams | Layers reach into implementations |
| Classes | Behavior ownership | Single responsible actor | Logic scattered across files |
| Enums | Closed value universes | Enum name at every call site | Magic strings in prose |
