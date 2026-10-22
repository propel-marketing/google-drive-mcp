# ADW — Observability

A running system must be as readable as its source code. These four mechanisms make it so.

---

## 1. Typed Results, Not Naked Exceptions

Every operation returns an explicit result type that carries both the success and failure case. The failure case is part of the contract — not an afterthought caught somewhere upstream.

```typescript
type OperationResult<T> =
  | { success: true;  data: T;     message: TrackingMessage }
  | { success: false; error: string; message: TrackingMessage }
```

**Why:** When an operation throws, the failure path is invisible at the call site. The caller has to know what to catch. When an operation returns a typed result, the call site is forced to handle both paths — the compiler enforces it, and the failure case is as visible as the success case.

**The failure mode:** Try/catch blocks that swallow errors silently, log a generic message, and return `null` or `undefined`. The caller has no signal that something failed, and the failure context is lost.

---

## 2. Print Everything at the Boundary

Every response is printed before it is returned. Every exception prints its full context — not just a message, but what was happening when it failed.

**At success:**
```typescript
console.log('[DatabaseSchemaAnalyzer.findRelationships] complete', {
  tableCount: result.tables.length,
  relationshipCount: result.relationships.length,
  durationMs,
})
return { success: true, data: result, message: trackingMessage }
```

**At failure:**
```typescript
console.error('[DatabaseSchemaAnalyzer.findRelationships] failed', {
  schemaId,
  error: err.message,
  stack: err.stack,
  durationMs,
})
return { success: false, error: err.message, message: trackingMessage }
```

**What to print:** The class and method name (greppable), the key input identifiers, the outcome, and the duration. On failure: the full error including stack.

**Why:** An agent watching a running system cannot open the source code. It sees only what the system prints. If the system is silent, the agent is blind. Boundary logging makes the running system tell its story.

---

## 3. Tracking Messages

Every response carries a `TrackingMessage` — a human-readable sentence the frontend can surface directly.

```typescript
type TrackingMessage = string

const successMessage: TrackingMessage = 
  "Found 12 tables and 8 relationships in your database schema."

const errorMessage: TrackingMessage = 
  "We couldn't find the database schema. Please check your connection and try again."
```

**Rules:**
- Both success and failure cases get a message
- Written for the user, not the developer — not `ERR_DB_SCHEMA_404`, but what that means to a user
- Specific enough to be actionable — not "Something went wrong"
- Included in the `OperationResult<T>` type so it is mechanically required at every return point

**Why:** Without tracking messages, the frontend translates developer error codes into user language — badly, inconsistently, and in multiple places. The backend already knows what happened. It should say so in plain language.

---

## 4. Endpoint Drillability

A well-designed endpoint answers four questions from one file:

1. **What comes in?** — exact input shape: body, params, headers
2. **What comes out?** — exact output shape on success
3. **What can fail?** — all failure cases and their status codes
4. **What does the user see?** — the message rendered to the user in each case

**The test:** Open the route handler file. Try to answer all four questions without leaving it. Count the additional files you must open.

| Files opened | Score |
|-------------|-------|
| 1 (the route file itself) | EXCELLENT |
| 2 | GOOD |
| 3–4 | POOR |
| 5+ | BROKEN |

**What a drillable endpoint looks like:**

```typescript
// Input schema — visible in this file
const RequestSchema = z.object({
  schemaId: z.string().uuid(),
})

// Handler
export async function GET(req: Request) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return Response.json({ 
      error: parsed.error.message,
      message: "Invalid request — schemaId must be a valid UUID."
    }, { status: 400 })
  }
  
  const result = await analyzer.findRelationships(parsed.data.schemaId)
  
  if (!result.success) {
    return Response.json({ 
      error: result.error,
      message: result.message   // user-facing message from the service
    }, { status: 500 })
  }
  
  // Output type — visible from the return
  return Response.json({ 
    data: result.data,          // DatabaseSchemaResponse
    message: result.message 
  })
}
```

**The failure mode:** Input schema lives in a separate validation file. Output type is implicit. Error messages are string literals scattered across the handler. The failure paths throw exceptions caught by a global error handler. Four files to answer four questions.
