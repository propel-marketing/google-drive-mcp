# Diagnose — Composition Root

You are checking that the composition root is singular, findable in under 5 minutes, and the only place that knows how the system wires in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

This diagnostic is discovery-driven via grep. No inventory file input required.

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## What This Diagnostic Proves

The composition root is the file that wires the system together — instantiates dependencies, configures registries, starts the runtime. There must be exactly one per deployable, and a new contributor should be able to find it in under five minutes.

When the composition root is fragmented (wiring scattered across multiple files), three things go wrong:
- Adding a new module requires editing several files in the right order
- Replacing a dependency requires hunting for every site that constructed it
- The system's structure is invisible — you cannot answer "what does this app contain?" from one file

---

## Step 1 — Find Candidate Composition Roots

Scan for files that match the composition-root profile: large, import many modules, contain instantiations and registrations, start the runtime.

```bash
# Files commonly serving as composition roots
find {{CODEBASE_PATH}}/src -type f \( -name "index.ts" -o -name "main.ts" -o -name "app.ts" -o -name "server.ts" -o -name "bootstrap.ts" -o -name "main.py" -o -name "main.rs" \) | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each candidate, get line count and import count:

```bash
for file in {{CANDIDATE_FILES}}; do
  echo "=== $file ==="
  wc -l "$file"
  grep -c "^import\|^from " "$file"
done
```

Composition roots are typically 500+ lines with 30+ imports. Files matching this profile are the candidates.

---

## Step 2 — Check Singularity

For the deployment shape of this codebase, determine how many composition roots are *expected*:
- **Single deployable** (one app) → expect 1
- **Multi-deployable** (web + worker, web + api, web + cli) → expect 1 per deployable

Read the package.json scripts (or equivalent build config) to identify deployables:

```bash
grep -A20 "\"scripts\"" {{CODEBASE_PATH}}/package.json 2>/dev/null
```

```bash
ls {{CODEBASE_PATH}}/cmd/ 2>/dev/null  # Go convention
ls {{CODEBASE_PATH}}/apps/ 2>/dev/null  # monorepo convention
```

Compare expected count to candidates found. Mismatch → fragmentation or hidden roots.

---

## Step 3 — Find Wiring Outside the Composition Root(s)

The composition root should be the *only* place that constructs domain dependencies. Find places where dependencies are constructed elsewhere:

```bash
# Service instantiations outside likely composition root locations
grep -rn "new [A-Z][A-Za-z]*Service(\|new [A-Z][A-Za-z]*Repository(\|new [A-Z][A-Za-z]*Manager(\|new [A-Z][A-Za-z]*Engine(" {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

```bash
# Singleton/factory patterns
grep -rn "getInstance(\|createSingleton\|globalThis\." {{CODEBASE_PATH}}/src --include="*.ts" | grep -v node_modules | grep -v ".next" | grep -v "test\|spec"
```

For each instantiation found *outside* the composition root files: this is wiring leakage. The composition root is no longer the single source of truth for how the system is wired.

Exception: factories that produce per-request instances (HTTP handlers, scoped repositories) legitimately construct in their handler. Distinguish per-request from per-app instantiation.

---

## Step 4 — Check Findability

The "five-minute findability" test: a new contributor opens the repo and tries to find the composition root.

Apply these tests:

| Test | Pass criteria |
|------|---------------|
| Top-level README mentions it | "The composition root lives at X" or equivalent |
| Filename is conventional | `index.ts`, `main.ts`, `app.ts` at `src/` root |
| Imports tell the story | The file imports every major domain module |
| Comments at top describe role | First 10 lines explain "this file wires the system" |

Score each composition root candidate on these four. Less than 3/4 means the root is technically present but not findable.

---

## Step 5 — Check What the Root Contains

Read each composition root. It should contain:
- Imports of all major domain modules
- Construction of dependencies (or DI container setup)
- Registration of routes / capabilities / handlers
- Runtime startup (HTTP server start, worker loop, CLI dispatch)

It should NOT contain:
- Domain logic (that belongs in domain modules)
- Schema definitions (that belongs in their domain folders)
- Business rules (that belongs in services/classes)

For each composition root, list what it contains. Flag any domain logic that has crept in.

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "architecture"
- `diagnostic_type`: "composition_root"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"architecture","diagnostic_type":"composition_root","severity":"MAJOR","file_path":"src/services/billing.ts","line_number":23,"description":"Per-app instantiation of StripeClient outside composition root — wiring is scattered","recommended_action":"Move construction to src/index.ts and inject via constructor","finding_signature":"a1b2c3d4e5f60011","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"composition_root","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [composition root] — fragmented across [N files] — consolidate to single root
2. [file] — wiring leak — move instantiation to composition root
3. [composition root] — findability score [N/4] — add README mention / rename / add header comment
4. [composition root] — domain logic leaked — extract to [domain module]
```

---

Append as final line:
`Status: COMPLETE`
