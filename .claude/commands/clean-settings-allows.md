---
description: Audit a Claude Code permission allow-list and remove one-off entries that won't generalize to future work.
argument-hint: "[optional path to a settings file; defaults to .claude/settings.local.json]"
---

You are cleaning a Claude Code permission allow-list so it holds only entries that stay useful for future work. One-off approvals accumulate because the user's default approval action is "always allow", and some of those approvals are pinned to a single session, a machine-specific path, or an ad-hoc command that will never recur verbatim.

## Target file

Operate on the path in `$ARGUMENTS` if one is given; otherwise default to `.claude/settings.local.json`. If the file has no `permissions.allow` array, say so and stop. Do NOT touch `.claude/settings.json` (the shared, committed file) unless the user explicitly names it as the argument.

## Steps

1. Read the target file and parse the `permissions.allow` array. Do not modify anything yet.
2. Classify every entry as KEEP or REMOVE using the criteria below.
3. Print a table of every REMOVE candidate — the entry text plus a one-line reason — and a KEEP-vs-REMOVE count. If there are zero removal candidates, report that the allow-list is already clean and stop.
4. Ask the user to confirm before writing. On confirmation, rewrite the file with the REMOVE entries deleted, preserving the order and formatting of the KEEP entries. Change nothing else in the file.
5. Confirm the result is still valid JSON by reading it back with the Read tool and inspecting it — do NOT run a fresh absolute-path validator command (e.g. `python3 -m json.tool /Users/…/settings.local.json`), because that would add a brand-new one-off allow entry and defeat the purpose. Report the new entry count.

## REMOVE — a one-off that will not generalize

Remove an entry when it is pinned to something ephemeral or unrepeatable:

- **Ephemeral identifier:** contains a session id, run id, plan id, request/prompt id, or timestamp — e.g. `--session-id <uuid>`, a UUID embedded in a path, `--run <id>`. Dead the moment that session ends.
- **Ephemeral or absolute path:** references a temp/scratchpad location (`/tmp/...`, `/private/tmp/...`, a session-scoped scratchpad dir) or an absolute machine path (`/Users/<name>/...`) that pins the rule to one machine or checkout.
- **Ad-hoc inline script:** an inline interpreter payload — `node -e "..."`, `python3 -c "..."`, `bash -c "..."` — encoding a specific literal that won't recur verbatim.
- **Redundant:** already fully covered by a broader rule present in the same list — e.g. `mcp__memory-bank__record_evidence` when whole-server `mcp__memory-bank` is also present, or a specific `Bash(git commit -m "...")` when `Bash(git commit:*)` is present.

## KEEP — reusable, generalizable approvals

- Tool-name grants: `Read`, `Write`, `Edit`, `WebSearch`, and MCP grants (`mcp__<server>` or a specific `mcp__<server>__<tool>`).
- Broad prefix/glob Bash rules: `Bash(npm test *)`, `Bash(git commit:*)`, `Bash(uv run:*)`.
- Stable project-relative commands that reference committed scripts and could recur, even when narrowly parameterized (e.g. `Bash(node scripts/init.mjs)`, a project CLI diagnostic like `Bash(... provenance-cli.ts ledger-status)`), as long as they carry no ephemeral identifier and no absolute machine path.

## Do not

- Do not generalize or rewrite entries into broader rules on your own — that changes the security posture. Only remove one-offs. If an entry could safely be broadened, mention it as a suggestion but leave it in place.
- Do not remove an entry just because it is narrow. Narrow is fine as long as it is repeatable; remove only when it is pinned to something ephemeral, absolute, ad-hoc, or redundant.
- Do not touch any key other than `permissions.allow`.
