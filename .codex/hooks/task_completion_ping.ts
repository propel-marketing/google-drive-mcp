#!/usr/bin/env tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd, env, exit } from "node:process";
import { spawnSync } from "node:child_process";

const KEYWORD_PATTERN = /(session|thread|conversation|run)[_-]?id/i;
const PLAN_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ACTIVE_PLANS_PATH = ".agents/active-plans.json";
const TASKS_SCRIPT_SUFFIX = ".agents/scripts/tasks.ts";

function readPayload(): Record<string, unknown> {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function commandText(payload: Record<string, unknown>): string {
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") return "";
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function splitShell(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function parseCliArgs(command: string): Record<string, string> {
  const parts = splitShell(command);
  const result: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if ((part === "--plan" || part === "--task-id" || part === "--caller") && parts[index + 1]) {
      result[part.slice(2)] = parts[index + 1];
    }
  }
  return result;
}

function isTasksCompleteCommand(command: string): boolean {
  const parts = splitShell(command);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.endsWith(TASKS_SCRIPT_SUFFIX) && parts[index + 1] === "complete") return true;
  }
  return false;
}

function extractIdentifiers(value: unknown, prefix = ""): Record<string, unknown> {
  const matches: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    value.forEach((child, index) => Object.assign(matches, extractIdentifiers(child, `${prefix}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (KEYWORD_PATTERN.test(key) && ["string", "number", "boolean"].includes(typeof child)) {
        matches[path] = child;
      }
      Object.assign(matches, extractIdentifiers(child, path));
    }
  }
  return matches;
}

function repoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : cwd();
}

function runRuntimeScript(root: string, scriptArgs: string[]): Record<string, unknown> | null {
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) return null;
  const result = spawnSync(process.execPath, [tsxCli, ...scriptArgs], {
    cwd: root,
    env: { ...env, CODEX_AGENT_ROOT: root },
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function summaryForPlan(root: string, plan: string): Record<string, unknown> | null {
  return runRuntimeScript(root, [join(root, ".agents", "scripts", "tasks.ts"), "summary", "--plan", plan]);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolvePlanRecord(root: string, plan: string): Record<string, unknown> | null {
  const payload = readJson(join(root, ACTIVE_PLANS_PATH));
  const plans = payload && typeof payload.plans === "object" ? payload.plans as Record<string, unknown> : {};
  const planEntry = plans[plan];
  return planEntry && typeof planEntry === "object" ? planEntry as Record<string, unknown> : null;
}

function resolveOutputDir(root: string, plan: string): string {
  const outputDir = resolvePlanRecord(root, plan)?.outputDir;
  return typeof outputDir === "string" && outputDir.trim() ? resolve(root, outputDir) : join(root, ".agents", "runs", plan);
}

function consumeArchitectureCompletion(root: string, plan: string, taskId: string, payloadIds: Record<string, unknown>): Record<string, unknown> | null {
  const planRecord = resolvePlanRecord(root, plan);
  if (!planRecord || planRecord.runner !== "architecture-runner") return null;

  const command = [
    join(root, ".agents", "scripts", "architecture-runner.ts"),
    "consume-completion",
    "--plan-name", plan,
    "--output-dir", resolveOutputDir(root, plan),
    "--task-id", taskId,
    "--mode", String(planRecord.mode ?? "audit"),
  ];
  const threadId = payloadIds.thread_id ?? payloadIds["tool_input.thread_id"];
  if (typeof threadId === "string" && threadId.trim()) command.push("--thread-id", threadId);
  return runRuntimeScript(root, command);
}

function writeEvent(root: string, plan: string, event: Record<string, unknown>): void {
  const orchestratorDir = join(resolveOutputDir(root, plan), "orchestrator");
  mkdirSync(orchestratorDir, { recursive: true });
  writeFileSync(join(orchestratorDir, "latest-completion.json"), `${JSON.stringify(event, null, 2)}\n`);
  appendFileSync(join(orchestratorDir, "completion-events.jsonl"), `${JSON.stringify(event)}\n`);
}

const payload = readPayload();
if (String(payload.tool_name ?? "") !== "Bash") exit(0);

const command = commandText(payload);
if (!command || !isTasksCompleteCommand(command)) exit(0);

const args = parseCliArgs(command);
const plan = args.plan;
const taskId = args["task-id"];
if (!plan || !taskId || !PLAN_TOKEN_PATTERN.test(plan)) exit(0);

const root = repoRoot();
if (!resolvePlanRecord(root, plan) && !existsSync(join(root, ".agents", "runs", plan))) exit(0);
const summary = summaryForPlan(root, plan);
const payloadIds = extractIdentifiers(payload);
const orchestration = consumeArchitectureCompletion(root, plan, taskId, payloadIds);

writeEvent(root, plan, {
  event: "managed_task_completed",
  observedAt: new Date().toISOString(),
  repoRoot: root,
  plan,
  taskId,
  caller: args.caller,
  command,
  orchestratorAction: {
    message: "Task completed. Parent orchestrator should consume outputs, close the completed child agent, and continue the managed plan loop.",
    closeCompletedChildAgent: true,
    continueManagedPlan: true,
  },
  payloadIdentifiers: payloadIds,
  orchestration,
  summary: {
    counts: summary?.counts,
    runnableTaskIds: summary?.runnableTaskIds,
    inProgressTaskIds: summary?.inProgressTaskIds,
    needsRevisionTaskIds: summary?.needsRevisionTaskIds,
    staleTaskIds: summary?.staleTaskIds,
  },
});
