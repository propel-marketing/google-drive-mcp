#!/usr/bin/env tsx
import process from "node:process";

const AGENT_SCRIPTS = ".agents/scripts/";
const ALLOWED_RUNTIME_SCRIPTS = [
  ".agents/scripts/tasks.ts",
  ".agents/scripts/audit-db.ts",
  ".agents/scripts/deposition-db.ts",
  ".agents/scripts/architecture-runner.ts",
  ".agents/scripts/workflow-runner.ts",
  ".agents/scripts/task-orchestration-runner.ts",
];

function readPayload(): Record<string, unknown> {
  try {
    const raw = require("node:fs").readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function commandText(payload: Record<string, unknown>): string {
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") return "";
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function editTargetPath(payload: Record<string, unknown>): string {
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") return "";
  const filePath = (toolInput as Record<string, unknown>).file_path;
  return typeof filePath === "string" ? filePath.replace(/\\/g, "/") : "";
}

function toolInputText(payload: Record<string, unknown>): string {
  const values: string[] = [];

  function collect(value: unknown): void {
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const child of value) collect(child);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) collect(child);
    }
  }

  collect(payload.tool_input ?? {});
  return values.join("\n");
}

function blocksOldClaudeRuntime(text: string): boolean {
  return [
    "~/.claude/tools/tasks.ts",
    "/.claude/tools/tasks.ts",
    "~/.claude/tools/audit-db.ts",
    "/.claude/tools/audit-db.ts",
    "~/.claude/tools/expert-db.ts",
    "/.claude/tools/expert-db.ts",
    "~/.claude/tools/forge-db.ts",
    "/.claude/tools/forge-db.ts",
  ].some((marker) => text.includes(marker));
}

function isAllowedAgentRuntimeCommand(command: string): boolean {
  return command.includes(AGENT_SCRIPTS) && ALLOWED_RUNTIME_SCRIPTS.some((script) => command.includes(script));
}

function mutatesRuntimeDbDirectly(command: string): boolean {
  if (!command.includes(".agents/data/") && !command.includes("/.agents/data/")) return false;
  if (isAllowedAgentRuntimeCommand(command)) return false;

  const destructivePrefix = /(^|[\s;&|])(rm|mv|cp|sqlite3|python3?|node|tsx|perl|sed)\b/.test(command);
  const shellRedirect = /(>|>>)\s*['"]?(?:\.agents\/data\/|\/.+?\/\.agents\/data\/)/.test(command);
  return destructivePrefix || shellRedirect;
}

function patchTouchesRuntimeDb(text: string): boolean {
  return /^[+*]{3} (?:Add|Update|Delete) File: .+\.agents\/data\//m.test(text);
}

function editTouchesRuntimeDb(text: string): boolean {
  return text.includes(".agents/data/");
}

function mutatesGeneratedTaskCache(command: string): boolean {
  if (!command.includes(".agents/runs/") || !command.includes("task-list.json")) return false;
  if (isAllowedAgentRuntimeCommand(command)) return false;

  const destructivePrefix = /(^|[\s;&|])(rm|mv|cp|python3?|node|tsx|perl|sed)\b/.test(command);
  const shellRedirect = /(>|>>)\s*['"]?(?:\.agents\/runs\/|\/.+?\/\.agents\/runs\/).+task-list\.json/.test(command);
  return destructivePrefix || shellRedirect;
}

function patchTouchesGeneratedTaskCache(text: string): boolean {
  return /^[+*]{3} (?:Add|Update|Delete) File: .+\.agents\/runs\/.+task-list\.json/m.test(text);
}

function editTouchesGeneratedTaskCache(text: string): boolean {
  return text.includes(".agents/runs/") && text.includes("task-list.json");
}

const payload = readPayload();
const toolName = String(payload.tool_name ?? "");
const command = commandText(payload);
const editTarget = editTargetPath(payload);
const allToolText = toolInputText(payload);

if (blocksOldClaudeRuntime(allToolText)) {
  deny(
    "Use the repo-local Codex agent runtime instead of ~/.claude/tools, run from the project root:\n" +
      "  node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts ...\n" +
      "  CODEX_AGENT_ROOT is an optional override and must be an absolute path to a checkout containing .agents/;\n" +
      "  it also applies to audit-db.ts and the packaged runner scripts.",
  );
}

if (toolName === "Bash" && mutatesRuntimeDbDirectly(command)) {
  deny(
    "Do not mutate .agents/data runtime databases directly. Use the repo-local " +
      "runtime scripts under .agents/scripts so schema initialization and validation run.",
  );
}

if (toolName === "Bash" && mutatesGeneratedTaskCache(command)) {
  deny(
    "Do not mutate .agents/runs/*/task-list.json directly. It is generated from " +
      "the task database; use .agents/scripts/tasks.ts instead.",
  );
}

if ((toolName === "Edit" || toolName === "Write") && editTouchesRuntimeDb(editTarget)) {
  deny("Do not edit .agents/data runtime databases directly. They are generated runtime state.");
}

if ((toolName === "Edit" || toolName === "Write") && editTouchesGeneratedTaskCache(editTarget)) {
  deny("Do not edit .agents/runs/*/task-list.json directly. Use .agents/scripts/tasks.ts instead.");
}

if (toolName === "apply_patch" && patchTouchesRuntimeDb(allToolText)) {
  deny("Do not edit .agents/data runtime databases through patches. They are generated runtime state.");
}

if (toolName === "apply_patch" && patchTouchesGeneratedTaskCache(allToolText)) {
  deny("Do not edit .agents/runs/*/task-list.json through patches. Use .agents/scripts/tasks.ts instead.");
}
