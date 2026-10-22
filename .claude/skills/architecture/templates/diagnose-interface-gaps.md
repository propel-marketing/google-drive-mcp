# Diagnose — Interface Gaps

You are checking interface coverage and the seam discipline of **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Your input is the interfaces inventory and the classes inventory. Read both, then expand by direct code scan only when the inventories leave gaps.

Write all findings to: `{{OUTPUT_PATH}}` (extension `.jsonl`)

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read these files first. Each must end with `Status: COMPLETE`.
If missing or incomplete: `Status: NEEDS_MORE_CONTEXT — interfaces or classes inventory is missing or incomplete`

{{PRIOR_FILE_1}}    (interfaces inventory)
{{PRIOR_FILE_2}}    (classes inventory)

---

## What This Diagnostic Proves

Interfaces are seams — deliberate doors where implementations can be swapped without touching anything downstream. When a class has no interface, it cannot be replaced, mocked, or tested in isolation. When an interface has no implementation, it's an empty contract — a documentation artifact pretending to be a seam.

The diagnostic checks four gaps:
- **Classes without an interface** — concrete-only, untestable in isolation
- **Interfaces without an implementing class** — empty seam, dead documentation
- **Multiple implementations without a stable interface** — the seam exists informally but is not enforced
- **Layer boundaries without an interface** — implementations reach into each other directly

---

## Step 1 — Build the Implementation Map

From the inventories, build a map of `Class → Interface(s) it implements`:

For each class in the classes inventory, check whether it declares `implements X`:

```bash
grep -rn "^export class [A-Z][A-Za-z]*.*implements\|^class [A-Z][A-Za-z]*.*implements" {{CODEBASE_PATH}}/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

Build the map:

```
Class                    | Implements
-------------------------|----------
EstimateRepository       | IEstimateRepository
EstimateApprover         | (none)
StripePaymentGateway     | PaymentGateway, BillingEventEmitter
SchemaAnalyzer           | (none)
```

---

## Step 2 — Build the Interface Coverage Map

From the interfaces inventory, build a map of `Interface → Implementing class(es)`:

Cross-reference each interface from inventory-interfaces with the implementations from Step 1:

```
Interface                | Implementations
-------------------------|----------------
IEstimateRepository      | EstimateRepository
PaymentGateway           | StripePaymentGateway, MockPaymentGateway (test)
ISessionStore            | (none)
LegacyOrderProcessor     | (none)
```

---

## Step 3 — Find Classes Without Interfaces

For each class in the classes inventory, classify:

| Class Status | Action |
|--------------|--------|
| Implements one or more interfaces | OK |
| Implements no interface, but has lifecycle/state | INTERFACE_MISSING |
| Implements no interface, has only static methods | NOT_A_CLASS — should be a module of functions |
| Implements no interface, but is a single-implementation utility (e.g., StringFormatter) | OK if internal-only |

Cross-cutting question: does the class hold state? If yes, it has lifecycle and benefits from a seam. If no, it's a module of functions wearing class clothes.

```bash
# Classes with state (have non-static fields or constructor that assigns to this.X)
grep -rn "^export class [A-Z]\|this\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -40
```

For each stateful class without an interface: INTERFACE_MISSING violation.

---

## Step 4 — Find Empty Interfaces (No Implementations)

For each interface from Step 2 with zero implementations: EMPTY_SEAM.

These are usually one of:
- Aspirational interfaces — defined for a planned implementation that never landed
- Dead interfaces — the implementation was deleted; the interface lingered
- Cross-package contracts — implementation lives in a different package and the inventory missed it

For each EMPTY_SEAM, search the broader codebase (including non-src locations) for the interface name:

```bash
grep -rn "implements [InterfaceName]\|: [InterfaceName]\b" {{CODEBASE_PATH}} --include="*.ts" | grep -v node_modules | grep -v ".next"
```

If still no implementation found anywhere: confirm the interface is dead and recommend deletion or implementation.

---

## Step 5 — Find Informal Seams (Multiple Implementations, No Interface)

Look for cases where multiple classes have similar method shapes but no shared interface:

For each class without an interface, check whether any other class in the inventory has the same method signatures. If two or more classes share method signatures and serve interchangeable roles (e.g., `StripePaymentGateway` and `PayPalPaymentGateway`, both with `charge(amount): Promise<Receipt>`), they should share an interface.

This step is judgment-based and partial — list all candidates rather than declaring violations definitively. The synthesis layer can confirm.

---

## Step 6 — Find Layer Boundaries Without Interfaces

The largest interface gap is at *layer boundaries*. Service A calling Service B directly means the boundary is invisible. Service A calling `IB` (interface) means the boundary is declared and the implementation is swappable.

From the inventory files (or from imports), identify cross-layer calls:

```bash
# Service-layer files importing from other service-layer files
grep -rn "^import.*from.*services" {{CODEBASE_PATH}}/src/services --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec" | head -30
```

For each cross-layer import, note: is the import a *concrete class* or an *interface*? Concrete imports across layer boundaries are seam violations.

---

## Step 7 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "boundary_hygiene"
- `diagnostic_type`: "interface_gaps"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"boundary_hygiene","diagnostic_type":"interface_gaps","severity":"CRITICAL","file_path":"src/app/api/estimates/route.ts","line_number":22,"description":"POST handler accepts body without schema validation — raw input reaches service layer","recommended_action":"Add CreateEstimateSchema.parse(body) before service call","finding_signature":"c6d4e2f0a8b9c1d3","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"interface_gaps","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"status":"complete"}

---

## Step 8 — Highest-Priority Issues

```
1. [class] — INTERFACE_MISSING + at layer boundary — define interface and have callers depend on it
2. [interfaces] — EMPTY_SEAM — implement or delete
3. [pair] — informal seam — promote to formal interface
4. [import path] — layer boundary violation — reach through interface, not concrete class
```

---

Append as final line:
`Status: COMPLETE`
