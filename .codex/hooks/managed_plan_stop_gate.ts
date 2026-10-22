#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { cwd, env, exit } from "node:process";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ACTIVE_REGISTRY = ".agents/active-plans.json";
const LEGACY_MARKERS = [".agents/active-managed-plan.json", ".agents/active-architecture-plan.json"];
const MANAGED_KINDS = new Set(["architecture", "workflow", "task-orchestration"]);

function loadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function firstLegacyMarker(repoRoot: string): Record<string, unknown> | null {
  for (const relPath of LEGACY_MARKERS) {
    const payload = loadJson(join(repoRoot, relPath));
    if (payload) return payload;
  }
  return null;
}

function activePlans(repoRoot: string): Array<Record<string, unknown>> {
  const registry = loadJson(join(repoRoot, ACTIVE_REGISTRY));
  const plans = registry && typeof registry.plans === "object" ? registry.plans as Record<string, unknown> : {};
  return Object.values(plans).filter((payload): payload is Record<string, unknown> => {
    if (!payload || typeof payload !== "object") return false;
    const plan = payload as Record<string, unknown>;
    return MANAGED_KINDS.has(String(plan.kind ?? "")) && plan.stopGuard === true;
  });
}

function loadSummary(repoRoot: string, planName: string): Record<string, unknown> | null {
  const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) return null;
  const tasksScript = join(repoRoot, ".agents", "scripts", "tasks.ts");
  const result = spawnSync(process.execPath, [tsxCli, tasksScript, "summary", "--plan", planName], {
    cwd: repoRoot,
    env: { ...env, CODEX_AGENT_ROOT: repoRoot },
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function block(message: string): never {
  console.log(JSON.stringify({ decision: "block", reason: message }));
  exit(0);
}

const repoRoot = cwd();
let plans = activePlans(repoRoot);
if (plans.length === 0) {
  const legacy = firstLegacyMarker(repoRoot);
  if (!legacy || legacy.stopGuard !== true) exit(0);
  plans = [legacy];
}

const blockers: string[] = [];
for (const plan of plans) {
  const planName = typeof plan.planName === "string" ? plan.planName : "";
  const outputDir = typeof plan.outputDir === "string" ? resolve(repoRoot, plan.outputDir) : "unknown";
  const kind = typeof plan.kind === "string" ? plan.kind : "managed";
  if (!planName) continue;

  const summary = loadSummary(repoRoot, planName);
  let incomplete: string[] | null = null;
  if (summary && Array.isArray(summary.tasks)) {
    incomplete = summary.tasks
      .filter((task) => task && typeof task === "object" && (task as Record<string, unknown>).status !== "completed")
      .map((task) => String((task as Record<string, unknown>).taskId ?? "unknown"));
  } else {
    const cache = loadJson(join(repoRoot, ".agents/runs", planName, "task-list.json"));
    if (cache) {
      incomplete = Object.entries(cache)
        .filter(([, payload]) => payload && typeof payload === "object" && (payload as Record<string, unknown>).status !== "completed")
        .map(([taskId]) => taskId);
    }
  }

  if (!incomplete) {
    blockers.push(`${kind} plan is active, but its DB summary and task cache are unavailable.\n- Plan: ${planName}\n- Output: ${outputDir}\n- Resume through the corresponding runner before stopping.`);
    continue;
  }
  if (incomplete.length === 0) continue;

  const preview = incomplete.slice(0, 8).join(", ");
  const extra = incomplete.length <= 8 ? "" : `, +${incomplete.length - 8} more`;
  blockers.push(`${kind} plan is still active and incomplete.\n- Plan: ${planName}\n- Output: ${outputDir}\n- Remaining tasks: ${incomplete.length}\n- Next tasks: ${preview}${extra}\n- Continue through the managed plan before stopping.`);
}

if (blockers.length > 0) block(blockers.join("\n\n"));
