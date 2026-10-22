# Final Spec Example

This file is the quality bar for `/architecture` and `/architecture:convert-to-spec`. It shows what a complete, high-quality audit output looks like at each stage. Use it during Final Review (Step 9) to evaluate whether the audit tree is ready to hand off to convert-to-spec.

---

## What "Complete" Looks Like at Each Phase

### Phase 1 — Inventory: Complete Means

Every building block is accounted for with specificity:

```markdown
### AuthTokenSchema

Location: src/services/auth/schemas.ts:23
Layer: backend
Validates: JWT payload shape before any auth check runs

Type derived via z.infer: YES
Type file: src/services/auth/types.ts:8

Call sites:
  - src/app/api/auth/route.ts:41 — at entry point: YES
  - src/services/auth/middleware.ts:18 — at entry point: YES

Called at runtime: YES
Called at correct boundary (entry point): YES
```

**Not complete if:**
- Entries say "various files" instead of naming file:line
- Schemas listed without call sites
- Classes listed without interface compliance check
- Enums inventory has no magic string section

---

### Phase 2 — Snapshot: Complete Means

A YAML where every element has a `file` field with line number, values are machine-readable (no prose), and the violations section is populated:

```yaml
schemas:
  - name: "AuthTokenSchema"
    file: "src/services/auth/schemas.ts:23"
    layer: backend
    validates: "JWT payload before auth check"
    type_derived: YES
    type_file: "src/services/auth/types.ts:8"
    called_at_runtime: YES
    call_sites:
      - "src/app/api/auth/route.ts:41"
    entry_point_guarded: YES

violations:
  critical:
    - file: "src/app/api/webhooks/stripe/route.ts:12"
      issue: "POST body enters unvalidated — no schema at entry point"
      source: inventory-entry-points
  major:
    - file: "src/services/billing/service.ts:89"
      issue: "`any` type in trusted code — Stripe response not validated"
      source: inventory-types-interfaces
```

**Not complete if:**
- Violations section is empty when inventory found issues
- Files listed without line numbers
- Summary counts don't match actual entries

---

### Phase 3 — Diagnose: Complete Means

Each diagnose output has specific file:line evidence for every finding, not general observations.

**Grep test — complete:**
```markdown
## Concept 1: AuthToken

Search: grep -rn "AuthToken" src/
Results: 23 total

| File:Line | Classification | What's happening |
|-----------|---------------|-----------------|
| src/services/auth/schemas.ts:23 | ORIGIN | Schema definition |
| src/services/auth/types.ts:8 | ORIGIN | Type derived via z.infer |
| src/app/api/auth/route.ts:41 | CONSUME | Validated at entry, used in handler |
| src/services/auth/middleware.ts:18 | TRANSFORM | Decoded and forwarded as AuthContext |

Results: 2 ORIGIN · 1 TRANSFORM · 1 CONSUME · 19 IMPORT · 0 NOISE
Noise ratio: 0%
Verdict: PASS — coherent origin-to-consume thread
```

**Grep test — not complete:** "AuthToken appears in many files and seems well-named."

**Trace — complete:**
```markdown
## Structure 1: StripeWebhookPayload

| Step | File:Line | Action | Type | Identity |
|------|-----------|--------|------|----------|
| 1 | src/app/api/webhooks/stripe/route.ts:12 | Received from POST body | unknown | DISSOLVED |
| 2 | src/app/api/webhooks/stripe/route.ts:14 | JSON.parse without schema | any | DISSOLVED (cast) |
| 3 | src/services/billing/service.ts:89 | Passed as `any` to handler | any | DISSOLVED |

Dissolution points: 3
1. route.ts:12 — JSON.parse with no schema — BLOCKER
2. route.ts:14 — as any cast — BLOCKER
3. service.ts:89 — any propagation into business logic — MAJOR
```

**Trace — not complete:** "The webhook payload loses type safety somewhere in the route."

---

### Phase 4 — Reflect and Map: Complete Means

Every remediation item has exact file, exact action, and a clear done condition:

```markdown
### CRITICAL — Unguarded entry points

1. CREATE schema for Stripe webhook at src/app/api/webhooks/stripe/route.ts:12
   Add: export const StripeWebhookSchema = z.object({ type: z.string(), data: z.object({ object: z.unknown() }) })
   Call: StripeWebhookSchema.safeParse(await req.json()) before any processing
   Done: grep -n "StripeWebhookSchema.safeParse" src/app/api/webhooks/stripe/route.ts → 1 match

### MAJOR — Type safety

2. DERIVE type from schema at src/services/billing/types.ts:34
   Current: export type StripeEvent = { type: string; data: { object: unknown } }
   Change to: export type StripeEvent = z.infer<typeof StripeWebhookSchema>
   Done: grep -n "export type StripeEvent = {" src/services/billing/types.ts → 0 matches

3. ADD interface IBillingService for BillingService class at src/services/billing/service.ts:1
   Methods to declare: processWebhook(event: StripeEvent): Promise<OperationResult<void>>
   Done: grep -n "implements IBillingService" src/services/billing/service.ts → 1 match
```

**Not complete if:**
- "Improve error handling in billing service" — no file:line, no specific action, no done condition
- "Consider adding schemas" — vague, not actionable
- "Refactor the route" — too broad

---

### Phase 5 — Principles Audit: Complete Means

A coverage matrix with every principle explicitly checked, and a COMPLETE verdict supported by ≥90% COVERED/CLEAN:

```markdown
| Principle | Checked In | Finding | In Remediation Plan | Status |
|-----------|-----------|---------|--------------------|----|
| Grep test: core nouns traceable | diagnose-grep-test | 4/5 pass — MUDDY | YES — 1 rename in plan | COVERED |
| Every type derived from schema | inventory-types | 3 types declared independently | YES — items 2,3,4 in plan | COVERED |
| Every class has interface | inventory-classes | 2 classes without interface | YES — items 3,7 in plan | COVERED |
| Schemas validated at entry points | inventory-entry-points | 2 unguarded | YES — items 1,5 in plan (CRITICAL) | COVERED |
| No magic strings | inventory-enums | 1 cluster found | YES — item 6 in plan | COVERED |
| Boundary logging present | inventory-observability | PARTIAL — 3 services missing | YES — items 8,9,10 in plan | COVERED |

Principles audited: 18 total
  COVERED: 16 · CLEAN: 1 · PARTIAL: 1 · GAP: 0 · FINDING_MISSING: 0

Audit completeness: 94%
Overall verdict: COMPLETE
```

**Not complete if:**
- Verdict is COMPLETE but there are FINDING_MISSING items
- Coverage matrix has rows with Status: GAP on CRITICAL principles
- Vague remediation items were not flagged

---

## What convert-to-spec Needs to See

Before running convert-to-spec, the audit tree should pass these checks:

- [ ] `adw-snapshot.yaml` has a `violations` section with at least the CRITICAL and MAJOR items from inventory
- [ ] `reflect-and-map.md` has a Remediation Plan with numbered items, each with exact file:line
- [ ] Every CRITICAL remediation item has a `.safeParse()` or schema guard as its action — not "validate input"
- [ ] `principles-audit.md` verdict is COMPLETE or GAPS_FOUND (not INCOMPLETE)
- [ ] No FINDING_MISSING items in principles-audit — if something was found, it must be in the plan

If any of these fail, the convert-to-spec review agents will find gaps. That is recoverable — but fixing them before convert-to-spec runs saves one full review pass.
