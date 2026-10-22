# ADW — Construction Guide

Seven steps for building a feature the right way from the start. Follow them in order — each one creates the foundation the next step depends on.

---

## Step 1 — Define the Domain Nouns

Before writing any logic, name the core concepts. These names are the keywords everything else will be built around.

**How:** Answer the question "what are the things in this domain?" Write 3–8 precise, verbose nouns.

| Bad | Good |
|-----|------|
| `schema` | `DatabaseSchemaResponse` |
| `plan` | `MigrationPlan` |
| `map` | `RelationshipMap` |
| `user` | `AuthenticatedUser` vs `PublicUserProfile` vs `DatabaseUserRow` |

**The test:** Can you grep for each noun and expect to find exactly the right set of files? If the name is too generic (would match noise), make it more specific. If the name is too specific (would miss legitimate uses), generalize it.

**Output:** A list of domain nouns with their definitions and their position in the trust hierarchy (raw, validated, transformed, persisted).

---

## Step 2 — Create the Schema at the Entry Point

Wherever data first enters the system — an API request body, an external API response, a file read, a database query — write the schema that validates it before anything else happens.

```typescript
export const DatabaseSchemaResponseSchema = z.object({
  tables: z.array(TableSchema),
  version: z.string().min(1),
  fetchedAt: z.string().datetime(),
})
```

**Entry points that must have schemas:**
- Every HTTP route body, query param, and header that is used
- Every external API response before it is stored or processed
- Every database jsonb column before its contents are accessed
- Every file read whose structure is not guaranteed by the file format itself

**The test:** Can a malformed value at this entry point reach layer 2 without failing? If yes, the schema is missing or not being called.

---

## Step 3 — Derive the Type from the Schema

One source of truth. Never write the type separately from the schema.

```typescript
export type DatabaseSchemaResponse = z.infer<typeof DatabaseSchemaResponseSchema>
```

This single line ensures the type and schema can never drift apart. Change the schema, the type updates automatically. A type that is written separately from its schema is two sources of truth waiting to diverge.

**Check:** Search the codebase for types that have corresponding schemas but are declared independently:
```bash
grep -rn "^type\|^interface" ./src --include="*.ts" | grep -v "infer<typeof"
```
Every independently declared type that corresponds to a schema is a drift risk.

---

## Step 4 — Design Interfaces at Layer Boundaries Before Writing Classes

For each layer boundary, write the interface before writing the implementation. The interface is the question "what does this layer promise?" — answered before implementation muddies the answer.

```typescript
interface ISchemaAnalyzer {
  findRelationships(schemaId: string): Promise<OperationResult<RelationshipMap>>
  generateMigrationPlan(from: DatabaseSchemaResponse, to: DatabaseSchemaResponse): MigrationPlan
}
```

**Layer boundaries that need interfaces:**
- Route handler → service
- Service → repository
- Repository → database client
- Service → external API client

**The test:** Can the implementation at each layer be replaced with a mock or a v2 without changing any code in the layer above? If yes, the interface is right. If no, the interface is missing or the boundary is in the wrong place.

---

## Step 5 — Assign Behavior to Classes with Names That State Purpose

Each class is an actor. Name it with a verb-noun pair that declares what it does.

```typescript
class DatabaseSchemaAnalyzer implements ISchemaAnalyzer {
  findRelationships(schemaId: string): Promise<OperationResult<RelationshipMap>> { ... }
  generateMigrationPlan(from: DatabaseSchemaResponse, to: DatabaseSchemaResponse): MigrationPlan { ... }
}
```

**The single responsibility check:** Read the class name. Does every method belong to an actor with that name? If `DatabaseSchemaAnalyzer` has a method that sends an email, the name is lying. Extract the method into a class whose name makes it obvious.

**Names that signal responsibility failure:** `Manager`, `Handler`, `Helper`, `Utils`, `Service` (without qualification). These are responsibility black holes — they accumulate unrelated behavior because their names don't refuse anything.

---

## Step 6 — Name Every Variable for Its Domain Role

Every variable name answers "what is this?" — not "what technical type is this?"

```typescript
const rawApiPayload = await externalApi.fetch(endpoint)
const parsedSchema = DatabaseSchemaResponseSchema.safeParse(rawApiPayload)
if (!parsedSchema.success) { ... }
const databaseSchemaResponse = parsedSchema.data
const relationshipMap = analyzer.findRelationships(databaseSchemaResponse)
```

Each name tells you where in the journey you are:
- `rawApiPayload` — untrusted, just received
- `parsedSchema` — the parse result object, not yet extracted
- `databaseSchemaResponse` — validated, trusted, named for its domain role
- `relationshipMap` — transformed, the output of analysis

**The audit:** Every variable named `data`, `res`, `result`, `obj`, or `payload` without qualification is a renaming candidate. The cost is a 10-second rename. The benefit is every future reader can understand the code without tracing back through the call chain.

---

## Step 7 — Verify with the Grep Test

After building, run the grep test against every domain noun you defined in Step 1.

```bash
grep -rn "DatabaseSchemaResponse" ./src --include="*.ts" | grep -v node_modules
```

**What you should see:** Results that trace origin → transformation → consumption coherently. The noun appears at its birth (the schema parse), travels through the system with its name intact, and is consumed at the boundary where the data's job is done.

**What means you're done:** Every noun passes the grep test. The results tell a story. No ABSENT or ALIASED verdicts.

**What means you're not done:** A noun has near-zero results (it was renamed mid-journey). A noun's aliases have more results than the canonical name (the aliases won). A noun's results don't form a story (origin or consumption is missing).

Fix the renames, re-run the test. The grep test is both the diagnostic and the definition of done.

---

## The Checklist

Before marking a feature complete, verify:

- [ ] Every core domain noun is named precisely and survives grep
- [ ] Every entry point has a schema — no unguarded boundaries
- [ ] Every TypeScript type is derived from its schema — one source of truth
- [ ] Every layer boundary has an interface — no direct implementation references
- [ ] Every class has a verb-noun name that states single responsibility
- [ ] Every variable name carries domain role, not technical type
- [ ] Every endpoint answers all four drillability questions from one file
- [ ] Every operation returns a typed result — no naked exceptions
- [ ] Every response is logged at the boundary — success and failure
- [ ] Every failure case carries a user-facing tracking message
