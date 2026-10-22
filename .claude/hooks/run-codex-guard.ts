import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_GUARD_NAMES = [
  "agent_runtime_policy",
  "comment_guard",
  "managed_plan_stop_gate",
  "task_completion_ping",
] as const;

type CodexGuardName = (typeof CODEX_GUARD_NAMES)[number];

const CODEX_GUARDS = new Set<string>(CODEX_GUARD_NAMES);

function writeBridgeFailure(message: string): number {
  process.stderr.write(`Claude guard bridge failed: ${message}\n`);
  return 2;
}

function normalizedPath(pathValue: string): string {
  const absolute = resolve(pathValue);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function gitRoot(startDirectory: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root.length > 0 && isAbsolute(root) ? resolve(root) : undefined;
}

function isVerifiedProjectRoot(candidate: string): boolean {
  const root = resolve(candidate);
  const discoveredGitRoot = gitRoot(root);
  if (
    discoveredGitRoot === undefined ||
    normalizedPath(discoveredGitRoot) !== normalizedPath(root)
  ) {
    return false;
  }
  return (
    existsSync(join(root, "node_modules", "tsx", "dist", "cli.mjs")) &&
    CODEX_GUARD_NAMES.every((guardName) =>
      existsSync(join(root, ".codex", "hooks", `${guardName}.ts`)),
    )
  );
}

function resolveProjectRoot(): string | undefined {
  const candidates: string[] = [];
  const claudeProjectDirectory = process.env.CLAUDE_PROJECT_DIR;
  if (claudeProjectDirectory !== undefined && claudeProjectDirectory.length > 0) {
    candidates.push(resolve(claudeProjectDirectory));
    const environmentGitRoot = gitRoot(claudeProjectDirectory);
    if (environmentGitRoot !== undefined) candidates.push(environmentGitRoot);
  }
  const currentGitRoot = gitRoot(process.cwd());
  if (currentGitRoot !== undefined) candidates.push(currentGitRoot);
  candidates.push(resolve(process.cwd()));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identity = normalizedPath(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (isVerifiedProjectRoot(candidate)) return resolve(candidate);
  }
  return undefined;
}

function validatedPayloadBytes(): Buffer | undefined {
  const rawPayload = readFileSync(0);
  try {
    const payload: unknown = JSON.parse(rawPayload.toString("utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    if (record.tool_name !== undefined && typeof record.tool_name !== "string") {
      return undefined;
    }
    if (
      record.tool_input !== undefined &&
      (record.tool_input === null ||
        typeof record.tool_input !== "object" ||
        Array.isArray(record.tool_input))
    ) {
      return undefined;
    }
    return rawPayload;
  } catch {
    return undefined;
  }
}

export function runCodexGuard(
  requestedGuardName = process.argv[2] ?? "",
): number {
  if (!CODEX_GUARDS.has(requestedGuardName)) {
    return writeBridgeFailure("unknown guard name");
  }
  const guardName = requestedGuardName as CodexGuardName;
  const payloadBytes = validatedPayloadBytes();
  if (payloadBytes === undefined) {
    return writeBridgeFailure("invalid hook payload");
  }
  const projectRoot = resolveProjectRoot();
  if (projectRoot === undefined) {
    return writeBridgeFailure("verified project root unavailable");
  }

  const tsxCliPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const guardPath = join(projectRoot, ".codex", "hooks", `${guardName}.ts`);
  const guardResult = spawnSync(process.execPath, [tsxCliPath, guardPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_AGENT_ROOT: projectRoot },
    input: payloadBytes,
    windowsHide: true,
  });

  if (guardResult.stdout.length > 0) process.stdout.write(guardResult.stdout);
  if (guardResult.stderr.length > 0) process.stderr.write(guardResult.stderr);
  if (guardResult.error !== undefined || guardResult.status === null) {
    return writeBridgeFailure("original guard unavailable");
  }
  return guardResult.status;
}

export function isDirectGuardBridgeExecution(
  entryPath = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (entryPath === undefined) return false;
  try {
    const normalizedModuleUrl = new URL(moduleUrl);
    if (normalizedModuleUrl.protocol !== "file:") return false;
    normalizedModuleUrl.search = "";
    normalizedModuleUrl.hash = "";
    return (
      normalizedPath(realpathSync(resolve(entryPath))) ===
      normalizedPath(realpathSync(fileURLToPath(normalizedModuleUrl)))
    );
  } catch {
    return false;
  }
}

if (isDirectGuardBridgeExecution()) {
  process.exitCode = runCodexGuard();
}
