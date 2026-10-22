# ADW — Structural Principles

How files, folders, and indexes are organized. Distinct from code principles (types, schemas, interfaces) — these govern the container, not the content. A codebase can have perfect types and shattered structure. Both matter.

---

## Principle 1 — File Size Signals Role

Files fall into two distinct populations with almost nothing in between. The gap between them is not arbitrary — it reflects the difference between a unit of work and a unit of wiring.

| Role | Lines | What it contains |
|------|-------|-----------------|
| `barrel` | 1–15 | Re-export statements only. No logic. |
| `unit` | 15–80 | One operation, one purpose. |
| `manager` | 80–200 | Domain registry, scheduler, lifecycle. |
| `complex` | 200–700 | Stateful module with real depth. |
| `adapter` | 700–1100 | One external protocol, full surface area. |
| `orchestrator` | 1000+ | Composition root or central brain. |
| `distributed-infra` | 1000+ | Coordination engine for distributed systems — queue state machines, run coordinators, debounce engines. Complexity is external and real (Redis, PostgreSQL, distributed state), not accidental. |

**The soft ceiling:** A non-orchestrator file past ~200 lines is doing more than one thing. That is a split signal, not a style concern.

**The exemption test — the decomposition question:** Before accepting size as legitimate, ask: *"Does decomposing this file require inventing a boundary that doesn't exist in the domain?"* If yes, the size is justified. If a natural boundary exists and the file crosses it anyway, the size is a smell regardless of role.

Exempt categories that regularly pass the decomposition test: composition roots, orchestrators, single-protocol adapters, and stateful distributed infrastructure. Everything else is a split candidate past ~200 lines.

**The failure mode:** A domain module that grew past 500 lines because nobody noticed. It now owns three operations that each belong to a dedicated unit. The decomposition test would have caught it — splitting requires no invented boundary, just extracting what was already there.

---

## Principle 2 — File Naming Mirrors Function Naming

The verbNoun rule for functions applies to files. A file that performs one operation is named for that operation. A file that holds or manages something is named for what it holds.

| Pattern | When to use | Examples |
|---------|-------------|---------|
| `verb-noun` (kebab-case) | File performs a single operation | `read-file`, `git-commit`, `schedule-task`, `cancel-task`, `run-command`, `install-skill` |
| `noun` (kebab-case) | File holds state or manages a domain | `permissions`, `registry`, `scheduler`, `lifecycle`, `identity`, `blocklist` |
| Role name | Structural file with a fixed purpose | `base` (abstract adapter), `index` (barrel or composition root), `types` (type definitions) |
| `name.boundary` suffix | File that must not cross a runtime boundary | `cancelTaskRun.server.ts`, `createCheckpoint.server.ts` — the `.server` suffix marks code that must not reach the browser (Prisma clients, secrets, Redis connections) |

**Suffix encoding is asymmetric by design.** Mark the dangerous side only. `.server.ts` exists; `.client.ts` does not — the safe side needs no warning. The suffix is a security boundary enforced by file naming and detectable by bundler config. Any runtime boundary where leakage causes a security or correctness failure warrants a suffix. Only that side needs it.

**The check:** Read the filename. Is this file performing an operation or managing a thing? Performing → verb-noun. Managing → noun. If it cannot be answered, the file has unclear responsibility — naming is downstream of design, not the problem itself.

**The failure mode:** A file named `user-service.ts` that contains 12 unrelated operations on users — account creation, session management, email verification, role assignment. The name is a noun but the file is an operation dump, not a manager. The noun name concealed a responsibility scatter.

---

## Principle 3 — Naming Specificity Increases With Depth

Folder names tell a different story at each level of the tree. The rule is not "everything must be domain-first" — it is that naming specificity must increase as depth increases.

```
── Small codebase (3 levels) ──────────────────────────────────────
src/                           ← inflection point: structural anchors OK here
  capabilities/                ← domain category: what the system does
    filesystem/                ← domain concept: which kind of capability
      read-file.ts             ← operation: the exact action
  types/                       ← structural anchor: OK at this inflection point
    message.ts                 ← domain concept it types

── Monorepo (5 levels) ────────────────────────────────────────────
packages/                      ← zone
  run-engine/                  ← domain concept
    src/                       ← inflection point: convention boundary for this package
      waitpoints/              ← domain concept
        lifecycleHooks/        ← domain concept → operations
```

- **Inflection points:** `src/`, `packages/`, version prefixes (`v3/`) — these are valid structural anchors at any depth where they mark the root of a distinct sub-system or a convention boundary. They are not violations even when they appear inside domain folders.
- **Domain levels:** Every non-inflection folder tells you what the system does. `filesystem`, `git`, `waitpoints`, `run-engine` — each name is a domain concept.
- **Leaf level:** Operations. Names are verb-noun, declaring exactly what the file does.

**The two-level rule:** A domain name must appear within two levels of any structural anchor. If you navigate two levels from a structural anchor and still haven't seen a domain concept — only more structural anchors or generic names — the tree has lost navigability at that depth.

**The signal for violation:** A folder at any non-inflection level named `helpers/`, `utils/`, or `common/`. These names refuse nothing. They are the folder equivalent of a variable named `data`.

---

## Principle 4 — Structural Anchors Belong at Inflection Points Only

`types/`, `utils/`, `helpers/` are structural anchor folders. They organize by technical role, not domain. They are valid at inflection points — the root of the whole project, the root of a package, the root of a distinct sub-system. They are never valid inside a domain folder.

**What counts as an inflection point:** The project root, a package root (`packages/run-engine/src/`), a top-level app boundary (`apps/webapp/src/`). These mark where a distinct sub-system begins. Structural anchors at these points orient that sub-system's tree.

**What does not count:** `src/capabilities/types/` — `capabilities/` is a domain folder, not a sub-system root. `src/memory/utils/` — same violation. These are the root structure leaking into a domain.

**Inside a domain folder:** Types live in `types.ts` — a single file — directly inside that domain folder. Not in a nested `types/` subfolder.

```
CORRECT:
  src/capabilities/
    permissions.ts
    registry.ts
    types.ts           ← flat file, not a folder

WRONG:
  src/capabilities/
    permissions.ts
    registry.ts
    types/             ← structural anchor inside a domain folder
      permissions.ts
      registry.ts
```

**The failure mode:** The root structure leaks downward. Every sub-domain gets its own `types/` and `utils/` subfolder. The tree now has `src/capabilities/types/`, `src/channels/types/`, `src/memory/types/` — the structural skeleton of the root repeated three times, adding navigation cost without adding domain clarity.

---

## Principle 5 — Composition Root and Barrel Index Are Different Roles

Both frequently use `index.ts` or `index.js`. They do completely different jobs. Knowing which is which matters for how an agent reads the file.

**Barrel index:** A domain folder's export surface. Contains re-export statements only. Size: 1–15 lines. Its job is to control what leaks out of a domain so consumers never import from files inside the folder directly.

```typescript
// src/capabilities/index.ts — barrel
export { CapabilityRegistry } from './registry.js'
export type { ChatCommandContext } from './registry.js'
```

**Composition root:** One file in the entire codebase that constructs every collaborator and wires them together. Contains `new ClassName()` calls and the full dependency graph. Size: large, legitimately. Its job is to be the only place the full assembly of the system is visible.

```typescript
// src/index.ts — composition root
const providers = new ProviderRegistry(config)
const capabilities = new CapabilityRegistry(skillLoader, scheduler, tokenBudget)
const agent = new Agent(config, providers, identity, shortTerm, longTerm, channels, capabilities, scheduler)
```

**The distinction matters for agents:** A barrel index should contain only exports — if an agent finds `new` calls inside it, the file is doing two jobs. The composition root should contain only wiring — if an agent finds domain logic inside it, it has leaked beyond its role.

**The failure mode:** A root `index.ts` that wires the application AND re-exports public types AND contains startup logic AND handles CLI commands. Four jobs in one file. None of them readable as a unit.

---

## Principle 6 — Documentation Has Three Audiences

Documentation is not a monolith. Three distinct audiences consume it, and each needs its own directory and format. Mixing them degrades all three.

| Audience | Where it lives | Format | Contents |
|----------|---------------|--------|----------|
| Human contributors | `docs/` or `ARCHITECTURE.md`, `DECISIONS.md` | Prose, diagrams, ADRs | Mental model, history, rationale, onboarding |
| CI / tooling | `scripts/`, config files at root | Machine-readable | Lint rules, type config, test config, build contracts |
| AI agents | `rules/` or `.claude/` versioned by API contract | Structured prose, YAML, injectable text | Agent-readable context, constraints, operational instructions |

**Agent documentation is first-class, not a dev convenience.** A codebase that invests in agent-injectable context gets consistent, grounded agent behavior. A codebase that omits it gets agents that hallucinate structure and miss critical constraints.

**Version by API contract, not by date.** The correct structure is `rules/4.0.0/` — a directory named for the API version the rules target. Not `rules/2024-11-13/` (a date), not `rules/` (flat, unmaintainable when contracts change). When the agent API version changes, the directory name changes; old rules are preserved and remain valid for older integrations.

**The separation test:** Can you answer "where do I look to understand this system's decisions?" (humans), "where does CI look to enforce contracts?" (tooling), and "where does an agent look to orient itself before acting?" (agents) with three different paths? If any two answers point to the same directory, the audiences are mixed.

**The failure mode:** Agent instructions embedded as comments in source files, or appended to `README.md`, or scattered in `docs/` alongside human-readable prose. An agent arriving cold cannot distinguish what is for it and what is for a human reader — so it reads everything, misses the operative constraints, and acts on noise.

---

## Summary

| Principle | What it governs | Failure mode |
|-----------|----------------|-------------|
| File size signals role | Line count bands by role | Non-orchestrator >200 lines doing multiple things |
| File naming mirrors function naming | verb-noun vs noun at file level | Operation file named as a noun; manager named as verb-noun |
| Naming specificity increases with depth | Domain specificity at each folder depth | `helpers/` or `utils/` at mid/leaf level |
| Structural anchors at inflection points only | Where `types/` and `utils/` folders live | Nested structural anchors inside domain sub-folders |
| Composition root and barrel index are different roles | What `index` files contain | Root index doing wiring + re-exports + logic |
| Documentation has three audiences | Where human, CI, and agent docs live | Agent instructions embedded in source or mixed into human docs |
