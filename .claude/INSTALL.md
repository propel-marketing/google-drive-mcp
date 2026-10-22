# Claude Code Setup

This guide installs the Claude Code compatibility overlay on macOS, Windows, or WSL without changing the native ADW runtime.
Generated mirrors are not hand-edited; update their native sources and regenerate them.

## Requirements

- macOS 13 or newer, Windows 10 1809 or newer, Windows Server 2019 or newer, or WSL.
- Node.js 22 or newer for this workspace.
- Git for Windows is recommended for native Windows shell support.
- Internet access is required for Claude authentication and the first local embedding-model download.
- An authenticated Claude account or another supported Claude Code authentication method is required.

## Install Claude Code

Anthropic recommends the native installer. In PowerShell, run:

```powershell
irm https://claude.ai/install.ps1 | iex
```

WinGet is an alternative: `winget install Anthropic.ClaudeCode`.
See the [official advanced setup](https://code.claude.com/docs/en/getting-started) for current platform options.
Open a new terminal after installation, then verify the CLI:

```powershell
claude --version
claude doctor
```

## Authenticate and Trust the Project

Change to the Propel-ADW root and start `claude`.
Complete the browser-based login or configured provider authentication when prompted.
Review and accept the project trust prompt only after confirming this is the intended workspace.
Claude loads `CLAUDE.md`, project agents, skills, settings, and hooks from their native `.claude` locations.

## Initialize the Workspace

From the project root, run the platform-aware initializer:

```text
node scripts/init.mjs
```

It verifies Node.js, npm, and Claude Code; installs all three locked dependency trees for the current operating system; and runs the Claude compatibility and provenance checks.
It does not silently install or update global tools. If a prerequisite is too old or missing, it stops with the required version so you can update that tool using your normal package manager.
Run `node scripts/init.mjs --check` to verify an existing installation without reinstalling dependencies.

When the ADW is installed into a host project rather than used as the Propel-ADW repository itself, run `node scripts/init.mjs --host-install` (or `--check --host-install`).
The host project owns its root `package.json`, `package-lock.json`, and `.gitignore`, so in host-install mode the Claude mirror verifier still requires those three files to exist but does not compare their contents with the Propel-ADW baseline.
Every other baseline file, including `AGENTS.md`, is still verified byte for byte. The flag sets `PROPEL_ADW_HOST_INSTALL=1` for the verification phases, and the verifier accepts `--host-install` directly.

When a checkout under `/mnt/` is shared between WSL and native Windows, its native Node dependencies can only match one platform at a time.
Rerun the initializer after switching environments, or use a separate WSL-local clone.

## Manual Dependency Installation

The initializer is preferred. If manual recovery is required, run all three clean installs from the project root and replace `<platform>` with `darwin`, `linux`, or `win32`:

```text
npm ci --os=<platform>
npm ci --prefix .claude/compatibility --os=<platform>
npm ci --prefix .agents/provenance --os=<platform>
```

These packages are isolated intentionally. Do not add their dependencies to the root manifests.
The explicit operating-system flag prevents a user-level npm platform override from selecting incompatible native packages.

## Line Endings

The compatibility verifier compares each native baseline file's raw byte length against `.claude/native-adw-baseline.json`, and those recorded lengths are LF. A CRLF checkout therefore fails verification even though the file content is otherwise identical.

The repository pins LF for all text files through the `* text=auto eol=lf` rule in `.gitattributes`. That attribute overrides `core.autocrlf`, so every clone checks out LF on every platform regardless of the local Git configuration.

A clone made before this rule existed, or a checkout that was converted to CRLF by an older `core.autocrlf=true` default, shows "Baseline byte-length drift" on many files when the initializer runs mirror verification. That symptom is line endings, not content drift. To repair such a clone, run from the project root:

```text
git config core.autocrlf false
git config core.eol lf
git ls-files -z | xargs -0 touch
git checkout-index --all --force
git read-tree HEAD
```

The sequence disables conversion locally, marks every tracked file as stale, rewrites the working tree from the LF index, and refreshes the index so `git status` is clean. Rerun `node scripts/init.mjs --check` afterwards.

## Generate and Verify Claude Mirrors

Run the generator only after changing native ADW instructions, agents, or skills:

```powershell
node .claude/compatibility/node_modules/tsx/dist/cli.mjs .claude/compatibility/generate-claude-mirrors.ts
node .claude/compatibility/node_modules/tsx/dist/cli.mjs .claude/compatibility/verify-claude-mirrors.ts --identity-clean
```

The parity contract requires one `CLAUDE.md`, 23 Claude agents, and 165 skill files.
Exactly 164 skills remain byte-identical; only the task-orchestration skill has declared lifecycle substitutions.
The verifier rejects missing or extra mirrors, undeclared wording changes, approval drift, and line-ending hash drift.

## Hooks and Provenance

When the hooks/settings phase materializes `.claude/settings.json`, it registers Claude-native hook events and behavior-neutral wrappers for existing ADW guards.
Guard wrappers must preserve the original guard output, errors, exit codes, and filesystem effects.
Provenance hooks are passive: capture failures never approve, deny, complete, or otherwise control ADW work.
Redacted runtime data stays under `.agents/data/provenance/` and is ignored by Git.

Run provenance commands from the project root:

```powershell
npm --prefix .agents/provenance run provenance -- sessions
npm --prefix .agents/provenance run provenance -- events --limit 25
npm --prefix .agents/provenance run provenance -- verify
npm --prefix .agents/provenance run provenance -- export <session-id> --format jsonl
npm --prefix .agents/provenance run provenance -- embed
npm --prefix .agents/provenance run provenance -- search "task failure"
```

The first `embed` or semantic `search` downloads the configured local MiniLM model and therefore needs network access.
Later embedding and search operations use the cached model under `.agents/data/provenance/models`.

## Optional Local Permission Preset

`.claude/settings.local.example.json` contains the reviewed project-local permission allow-list used during development. Claude Code does not auto-load this example file.

During an interactive normal initialization, `node scripts/init.mjs` asks whether to copy the sample to the intentionally ignored local settings path. Answer `y` or `yes` to deploy it. The initializer never overwrites an existing `.claude/settings.local.json` file, and `--check` never prompts or copies it.

For non-interactive initialization, or to deploy the preset manually, use:

```bash
cp .claude/settings.local.example.json .claude/settings.local.json
```

PowerShell equivalent:

```powershell
Copy-Item .claude/settings.local.example.json .claude/settings.local.json
```

Run `/clean-settings-allows` periodically to identify session-specific, absolute-path, ad-hoc, or redundant approvals. The command shows proposed removals and asks for confirmation before changing the local file.

## Troubleshooting

If `claude` is not found, open a new terminal and run `Get-Command claude`.
If installation still fails, rerun `claude doctor` and consult Anthropic's installation troubleshooting guide.
If npm selects Linux packages on Windows, inspect `npm config get os --location=user`.
Keep the root and isolated package manifests unchanged; repeat the two clean installs with `--os=win32`.
If mirror verification fails, regenerate once, review the exact reported drift, and never patch generated mirrors directly.
If provenance verification reports pending JSONL or spool records, run `npm --prefix .agents/provenance run provenance -- repair`.
Do not commit `.claude/settings.local.json`, authentication data, model caches, SQLite files, JSONL ledgers, or recovery spools.
