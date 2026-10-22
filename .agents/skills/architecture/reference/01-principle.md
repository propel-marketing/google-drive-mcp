# ADW — The Meta-Principle

## What This Is

A framework for evaluating whether a codebase can be read by an agent — or by a human who doesn't already know the system. Every principle in ADW traces back to one test.

---

## The Test

**Can you grep for a core domain concept and follow it — origin, transformation, consumption — without losing the thread?**

If yes: the architecture is optimized.
If no: something is muddy. Find what broke the thread.

This is not a metaphor. Run the literal grep:

```bash
grep -rn "DatabaseSchemaResponse" ./src --include="*.ts"
```

Read the results. Do they tell a story? Do you see where the concept is born, how it changes shape, where it's finally used? Or do you see noise — aliases, generic names, casts — that break the chain?

The grep test is both the diagnostic and the definition of done. When every core domain concept passes it, the architecture is coherent.

---

## Why Agent-Readability Matters

An agent reading a codebase cannot hold the whole thing in memory. It follows threads. It greps, reads a file, follows an import, reads another file. If the thread breaks — because a concept was renamed to `data`, cast to `any`, or scattered across three utility files — the agent loses the story and has to guess.

The same is true for a developer who didn't write the code. The architecture optimized for agent-readability is optimized for any future reader.

---

## The Core Discipline

Every principle in ADW exists to keep the thread intact:

- **Names** carry domain role, not technical type — so grep finds the concept, not noise
- **Types** are declared and preserved — so the compiler tracks the thread for you
- **Schemas** validate at entry points — so corrupted data fails immediately, not three layers deep
- **Interfaces** define layer contracts — so each layer's seam is visible and greppable
- **Classes** own their behavior — so `grep DatabaseSchemaAnalyzer` shows you everything that concept does
- **Enums** close the universe of valid values — so every call site speaks the same vocabulary
- **Observability** is built in — so the running system tells the same story the source code does

---

## What Breaks the Thread

| Symptom | What happened |
|---------|---------------|
| Grep returns 0 results | The concept was never named — it lives as `data`, `res`, `obj` |
| Grep returns 200+ noise results | The name is too generic — `Manager`, `Handler`, `Service` |
| Results don't form a story | The concept was renamed mid-journey — `schema` became `result` became `payload` |
| Story ends abruptly | The type was dissolved — cast to `any`, destructured anonymously, passed as generic `object` |
| Multiple names for one thing | Aliases exist — fix by picking the canonical name and eliminating variants |

---

## The Standard

A codebase passes ADW when:

1. Every core domain concept has a canonical name that survives grep
2. That name traces cleanly from origin → transformation → consumption
3. Types are preserved across the entire journey — no `any`, no unexplained casts
4. Each layer boundary has an interface contract
5. Every entry point has a schema
6. Every endpoint answers all four drillability questions from one file
