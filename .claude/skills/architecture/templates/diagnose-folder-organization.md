# Diagnose — Folder Organization

You are checking whether folder structure is domain-first or tech-role in **{{FEATURE_NAME}}** at `{{CODEBASE_PATH}}`.

Read this inventory file:
- `{{INV_DIR}}/folder-structure.jsonl`

Write all findings to: `{{OUTPUT_PATH}}`

---

## ADW Reference

{{EMBEDDED_REFERENCE}}

---

## Input

Read the inventory file listed above. It must end with `Status: COMPLETE`.
If the inventory file is missing: `Status: NEEDS_MORE_CONTEXT — required inventory file is missing.`

- `{{INV_DIR}}/folder-structure.jsonl`

---

## What This Diagnostic Proves

The folder structure is the first thing an agent reads about a codebase. If top-level folders name domain concepts (`payments`, `auth`, `conversations`), the agent learns what the system *does* before opening a file. If they name technical roles (`controllers`, `services`, `models`), the agent learns nothing about the domain — it has to read code to find out.

The signal: describe the folder structure to a non-engineer who uses the product. If they can guess what lives in each folder, it's domain-first. If you have to explain what a "service" or "controller" is before they can follow, it's tech-role.

The exception is genuine infrastructure: auth, logging, database connections, rate limiting. These are not domain concepts; they're the plumbing the domain runs on. They legitimately get their own home at the structural level.

---

## Step 1 — List Top-Level Source Folders

```bash
ls -d {{CODEBASE_PATH}}/src/*/ 2>/dev/null | xargs -n1 basename
```

If the codebase uses `app/`, `lib/`, `packages/` as roots, list each:

```bash
ls -d {{CODEBASE_PATH}}/src/app/*/ 2>/dev/null | xargs -n1 basename
ls -d {{CODEBASE_PATH}}/src/lib/*/ 2>/dev/null | xargs -n1 basename
ls -d {{CODEBASE_PATH}}/packages/*/ 2>/dev/null | xargs -n1 basename
```

---

## Step 2 — Classify Each Top-Level Folder

For each folder name found, classify:

| Classification | Indicator |
|---------------|-----------|
| **DOMAIN** | Names a thing the product does or a thing it deals with (`estimates`, `crew-scheduling`, `inspections`, `chats`, `users`) |
| **INFRASTRUCTURE** | Names plumbing the domain runs on (`auth`, `logging`, `db`, `rate-limit`, `config`, `observability`) |
| **TECH_ROLE** | Names a technical layer or category (`controllers`, `services`, `models`, `utils`, `helpers`, `views`, `lib`) |
| **AMBIGUOUS** | Name could be either domain or tech (`api`, `core`, `common`) — investigate contents |

For AMBIGUOUS folders, list the files inside:
```bash
ls {{CODEBASE_PATH}}/src/{folder} 2>/dev/null
```

If the contents are domain entities, classify as DOMAIN. If they're cross-cutting utilities, classify as INFRASTRUCTURE or TECH_ROLE.

---

## Step 3 — Apply the Non-Engineer Test

For each folder classified as DOMAIN, write a one-sentence guess of what lives there *based only on the name*. Then verify against the actual contents.

```
| Folder | Name-Only Guess | Actual Contents | Match? |
|--------|----------------|-----------------|--------|
| estimates | Estimate creation, approval, sending | Yes — Estimate-related files | YES |
| crew-scheduling | Scheduling crew to job sites | Mixed: crew + jobs + invoicing | NO — split |
```

For each NO match: the folder name doesn't predict its contents. Either:
- The folder is doing too much (split by sub-domain)
- The folder is misnamed (rename to match contents)

---

## Step 4 — Check for Tech-Role Folders Inside Domain Folders

```bash
find {{CODEBASE_PATH}}/src -type d \( -name "controllers" -o -name "services" -o -name "models" -o -name "utils" -o -name "helpers" -o -name "types" -o -name "schemas" \) | grep -v node_modules | grep -v ".next"
```

For each tech-role folder found, note its parent. If parent is a domain folder (e.g., `src/payments/utils/`), this is a structural anchor leak — utility/services/models folders should not exist *inside* domain folders. They scatter the domain across technical sub-layers.

Exception: `src/types/` or `src/utils/` at the *root* is acceptable for cross-domain shared types/utilities. The violation is a tech-role folder *inside* a domain folder.

---

## Step 5 — Check Domain Hierarchy Depth

For each DOMAIN folder, measure the path depth and check for the `domain → subdomain → operation → file` flow.

```bash
find {{CODEBASE_PATH}}/src/{domain} -type f -name "*.ts" | head -20
```

Healthy hierarchy: `serp/organic/parsing/featured-snippet.ts` — domain, subdomain, operation, file.

Unhealthy patterns:
- Flat domain (everything at the top level) — sub-concepts not yet identified
- Over-deep (5+ levels) — abstractions stacked beyond what the domain warrants
- Mixed (some sub-folders are domain, others are tech-role) — incoherent organization

---

## Step 6 — Write Findings

Write one JSONL line per finding to `{{OUTPUT_PATH}}` (extension `.jsonl`). Every line must be valid JSON.

Required fields:
- `category`: "architecture"
- `diagnostic_type`: "folder_organization"
- `severity`: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
- `file_path`: string | null (directory path for folder findings)
- `line_number`: integer | null
- `description`: specific description
- `recommended_action`: string | null
- `finding_signature`: first 16 hex chars of SHA-256 of "category:file_path:line_number:description_normalized"
- `confidence`: "parsed" | "pattern_matched" | "ai_judged"

Example:
{"category":"architecture","diagnostic_type":"folder_organization","severity":"MAJOR","file_path":"src/controllers","line_number":null,"description":"TECH_ROLE folder 'controllers' at top level — names a layer, not a domain concept","recommended_action":"Absorb into domain folders or rename to reflect the domain it serves","finding_signature":"d4e5f60711223344","confidence":"ai_judged"}

After all findings:
{"_summary":true,"diagnostic_type":"folder_organization","total_findings":N,"by_severity":{"CRITICAL":0,"MAJOR":0,"MINOR":0,"INFO":0},"organization_style":"DOMAIN_FIRST|MIXED|TECH_ROLE","status":"complete"}

---

## Step 7 — Highest-Priority Issues

```
1. [folder] — TECH_ROLE at top level — rename or absorb into domain folders
2. [folder] — anchor leak (utils inside domain) — extract to root utils or rename
3. [folder] — non-engineer test fails — split or rename to match contents
```

---

Append as final line:
`Status: COMPLETE`
