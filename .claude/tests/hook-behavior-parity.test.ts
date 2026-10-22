import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectGuardBridgeExecution } from "../hooks/run-codex-guard.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardNames = [
  "agent_runtime_policy",
  "comment_guard",
  "managed_plan_stop_gate",
  "task_completion_ping",
] as const;

type GuardName = (typeof guardNames)[number];

type GuardExecution = Pick<
  SpawnSyncReturns<Buffer>,
  "status" | "signal" | "stdout" | "stderr" | "error"
>;

function copyDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function createFixtureRepository(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "Spark ADW hook parity "));
  mkdirSync(join(fixtureRoot, ".codex", "hooks"), { recursive: true });
  mkdirSync(join(fixtureRoot, ".claude", "hooks"), { recursive: true });
  for (const guardName of guardNames) {
    cpSync(
      join(sourceRoot, ".codex", "hooks", `${guardName}.ts`),
      join(fixtureRoot, ".codex", "hooks", `${guardName}.ts`),
    );
  }
  cpSync(
    join(sourceRoot, ".claude", "hooks", "run-codex-guard.ts"),
    join(fixtureRoot, ".claude", "hooks", "run-codex-guard.ts"),
  );
  cpSync(
    join(sourceRoot, ".claude", "package.json"),
    join(fixtureRoot, ".claude", "package.json"),
  );
  copyDirectory(
    join(sourceRoot, "node_modules", "tsx"),
    join(fixtureRoot, "node_modules", "tsx"),
  );
  copyDirectory(
    join(sourceRoot, "node_modules", "esbuild"),
    join(fixtureRoot, "node_modules", "esbuild"),
  );
  copyDirectory(
    join(sourceRoot, "node_modules", "@esbuild"),
    join(fixtureRoot, "node_modules", "@esbuild"),
  );
  const gitInit = spawnSync("git", ["init", "--quiet"], {
    cwd: fixtureRoot,
    windowsHide: true,
  });
  assert.equal(gitInit.status, 0);
  assert.match(fixtureRoot, /\s/u);
  return fixtureRoot;
}

function hookEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const executablePaths = [
    join(sourceRoot, "node_modules", ".bin"),
    join(sourceRoot, ".claude", "compatibility", "node_modules", ".bin"),
    process.env.PATH ?? "",
  ];
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: fixtureRoot,
    PATH: executablePaths.join(delimiter),
  };
}

function executeGuard(
  fixtureRoot: string,
  guardName: string,
  payload: unknown,
  throughBridge: boolean,
): GuardExecution {
  const tsxCli = join(
    fixtureRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const script = throughBridge
    ? join(fixtureRoot, ".claude", "hooks", "run-codex-guard.ts")
    : join(fixtureRoot, ".codex", "hooks", `${guardName}.ts`);
  const args = throughBridge
    ? [tsxCli, script, guardName]
    : [tsxCli, script];
  return spawnSync(process.execPath, args, {
    cwd: fixtureRoot,
    env: hookEnvironment(fixtureRoot),
    input: Buffer.from(JSON.stringify(payload)),
    windowsHide: true,
  });
}

function assertExecutionParity(
  fixtureRoot: string,
  guardName: GuardName,
  payload: unknown,
): void {
  const original = executeGuard(fixtureRoot, guardName, payload, false);
  const bridged = executeGuard(fixtureRoot, guardName, payload, true);
  assert.equal(original.error, undefined);
  assert.equal(bridged.error, undefined);
  assert.equal(bridged.status, original.status);
  assert.equal(bridged.signal, original.signal);
  assert.deepEqual(bridged.stdout, original.stdout);
  assert.deepEqual(bridged.stderr, original.stderr);
}

function writeManagedPlanFixture(
  fixtureRoot: string,
  taskStatus: "pending" | "completed",
  registryOutputDir = join(fixtureRoot, ".agents", "runs", "fixture-plan"),
): void {
  const outputDirectory = join(fixtureRoot, ".agents", "runs", "fixture-plan");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(fixtureRoot, ".agents", "active-plans.json"),
    JSON.stringify({
      plans: {
        "fixture-plan": {
          planName: "fixture-plan",
          outputDir: registryOutputDir,
          kind: "task-orchestration",
          mode: "execute",
          updatedAt: "2026-07-18T00:00:00.000Z",
          status: "active",
          stopGuard: true,
        },
      },
    }),
  );
  writeFileSync(
    join(outputDirectory, "task-list.json"),
    JSON.stringify({ "fixture-task": { status: taskStatus } }),
  );
}

function normalizedCompletionEvent(pathValue: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(pathValue, "utf8")) as Record<
    string,
    unknown
  >;
  delete parsed.observedAt;
  return parsed;
}

function assertCompletionEventParity(
  fixtureRoot: string,
  command: string,
): void {
  const payload = { tool_name: "Bash", tool_input: { command } };
  const outputDirectory = join(
    fixtureRoot,
    ".agents",
    "runs",
    "fixture-plan",
    "orchestrator",
  );
  rmSync(outputDirectory, { recursive: true, force: true });
  const original = executeGuard(
    fixtureRoot,
    "task_completion_ping",
    payload,
    false,
  );
  assert.equal(original.status, 0);
  const originalLatest = normalizedCompletionEvent(
    join(outputDirectory, "latest-completion.json"),
  );
  const originalJsonl = normalizedCompletionEvent(
    join(outputDirectory, "completion-events.jsonl"),
  );
  rmSync(outputDirectory, { recursive: true, force: true });

  const bridged = executeGuard(
    fixtureRoot,
    "task_completion_ping",
    payload,
    true,
  );
  assert.equal(bridged.status, original.status);
  assert.deepEqual(bridged.stdout, original.stdout);
  assert.deepEqual(bridged.stderr, original.stderr);
  assert.deepEqual(
    normalizedCompletionEvent(join(outputDirectory, "latest-completion.json")),
    originalLatest,
  );
  assert.deepEqual(
    normalizedCompletionEvent(join(outputDirectory, "completion-events.jsonl")),
    originalJsonl,
  );
}

test("run-codex-guard preserves all original guard behavior", async (context) => {
  const fixtureRoot = createFixtureRepository();
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  await context.test("agent_runtime_policy parity", () => {
    const payloads = [
      {
        tool_name: "Bash",
        tool_input: {
          command: "sqlite3 .agents/data/tasks.db 'delete from tasks'",
        },
      },
      {
        tool_name: "Bash",
        tool_input: { command: "tsx ~/.claude/tools/tasks.ts get" },
      },
      {
        tool_name: "Bash",
        tool_input: {
          command: "node .agents/runs/fixture/task-list.json",
        },
      },
      {
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: .agents/runs/fixture/task-list.json\n@@\n-{}\n+{\\\"changed\\\":true}\n*** End Patch",
        },
      },
    ];
    for (const payload of payloads) {
      assertExecutionParity(
        fixtureRoot,
        "agent_runtime_policy",
        payload,
      );
    }
  });

  await context.test("agent_runtime_policy decides Edit and Write from the destination path", () => {
    const taskCacheFileName = ["task-list", "json"].join(".");
    const relativeTaskCachePath = [".agents", "runs", "fixture", taskCacheFileName].join("/");
    const runtimeDbMention = [".agents", "data", "tasks.db"].join("/");
    const protectedPathMentions = `${relativeTaskCachePath}\n${runtimeDbMention}\n`;
    const notesPath = join(fixtureRoot, "notes.md");
    const decisionCases = [
      {
        name: "Write to the task cache at a native absolute path",
        expectedDecision: "deny",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: join(fixtureRoot, ".agents", "runs", "fixture", taskCacheFileName),
            content: "{}",
          },
        },
      },
      {
        name: "Edit of the task database at a native absolute path",
        expectedDecision: "deny",
        payload: {
          tool_name: "Edit",
          tool_input: {
            file_path: join(fixtureRoot, ".agents", "data", "tasks.db"),
            old_string: "before",
            new_string: "after",
          },
        },
      },
      {
        name: "Write to the task cache at a forward-slash relative path",
        expectedDecision: "deny",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: relativeTaskCachePath,
            content: "{}",
          },
        },
      },
      {
        name: "Write to an ordinary file whose content names protected paths",
        expectedDecision: "allow",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: notesPath,
            content: protectedPathMentions,
          },
        },
      },
      {
        name: "Edit of an ordinary file whose new text names protected paths",
        expectedDecision: "allow",
        payload: {
          tool_name: "Edit",
          tool_input: {
            file_path: notesPath,
            old_string: "before",
            new_string: protectedPathMentions,
          },
        },
      },
    ];
    for (const decisionCase of decisionCases) {
      const guardExecution = executeGuard(
        fixtureRoot,
        "agent_runtime_policy",
        decisionCase.payload,
        false,
      );
      const guardStdout = guardExecution.stdout.toString().trim();
      const observedDecision =
        guardStdout === ""
          ? "allow"
          : JSON.parse(guardStdout).hookSpecificOutput?.permissionDecision === "deny"
            ? "deny"
            : `unexpected output: ${guardStdout}`;
      assert.equal(observedDecision, decisionCase.expectedDecision, decisionCase.name);
      assertExecutionParity(
        fixtureRoot,
        "agent_runtime_policy",
        decisionCase.payload,
      );
    }
  });

  await context.test("comment_guard Write Edit and apply_patch parity", () => {
    const payloads = [
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(fixtureRoot, "written.ts"),
          content: "// added explanation\nconst value = 1;\n",
        },
      },
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(fixtureRoot, "edited.ts"),
          old_string: "const value = 1;",
          new_string: "// added explanation\nconst value = 1;",
        },
      },
      {
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Add File: patched.ts\n+// added explanation\n+const value = 1;\n*** End Patch",
        },
      },
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(fixtureRoot, "allowed.ts"),
          content: "const value = 1;\n",
        },
      },
    ];
    for (const payload of payloads) {
      assertExecutionParity(fixtureRoot, "comment_guard", payload);
    }
  });

  await context.test("managed_plan_stop_gate allow and block parity", () => {
    writeManagedPlanFixture(fixtureRoot, "pending");
    assertExecutionParity(
      fixtureRoot,
      "managed_plan_stop_gate",
      { hook_event_name: "Stop" },
    );
    writeManagedPlanFixture(fixtureRoot, "completed");
    assertExecutionParity(
      fixtureRoot,
      "managed_plan_stop_gate",
      { hook_event_name: "Stop" },
    );
  });

  await context.test("task_completion_ping side-effect parity", () => {
    writeManagedPlanFixture(fixtureRoot, "completed");
    assertCompletionEventParity(
      fixtureRoot,
      "tsx ./.agents/scripts/tasks.ts complete --plan fixture-plan --task-id fixture-task --caller tester",
    );
  });

  await context.test("task_completion_ping ignores an invalid plan token", () => {
    writeManagedPlanFixture(fixtureRoot, "completed");
    const payload = {
      tool_name: "Bash",
      tool_input: {
        command:
          "tsx ./.agents/scripts/tasks.ts complete --plan $plan --task-id t --caller tester",
      },
    };
    for (const throughBridge of [false, true]) {
      const execution = executeGuard(
        fixtureRoot,
        "task_completion_ping",
        payload,
        throughBridge,
      );
      assert.equal(execution.error, undefined);
      assert.equal(execution.status, 0);
      assert.equal(execution.stdout.length, 0);
      assert.equal(execution.stderr.length, 0);
    }
    assert.equal(existsSync(join(fixtureRoot, ".agents", "runs", "$plan")), false);
  });

  await context.test("task_completion_ping detects the cli.mjs form", () => {
    writeManagedPlanFixture(fixtureRoot, "completed");
    assertCompletionEventParity(
      fixtureRoot,
      "node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts complete --plan fixture-plan --task-id fixture-task --caller tester",
    );
  });

  await context.test("task_completion_ping resolves a relative registry outputDir", () => {
    writeManagedPlanFixture(fixtureRoot, "completed", ".agents/runs/fixture-plan");
    assertCompletionEventParity(
      fixtureRoot,
      "node ./node_modules/tsx/dist/cli.mjs ./.agents/scripts/tasks.ts complete --plan fixture-plan --task-id fixture-task --caller tester",
    );
  });

  await context.test("unknown and traversal guard names fail closed", () => {
    for (const guardName of ["unknown", "../comment_guard", "comment_guard.ts"]) {
      const result = executeGuard(fixtureRoot, guardName, {}, true);
      assert.equal(result.status, 2);
      assert.equal(result.stdout.length, 0);
      assert.match(result.stderr.toString("utf8"), /unknown guard name/u);
    }
    assert.equal(existsSync(join(fixtureRoot, ".codex", "comment_guard.ts")), false);
  });
});

test("run-codex-guard detects loader-decorated entry module URLs", () => {
  const bridgePath = join(
    sourceRoot,
    ".claude",
    "hooks",
    "run-codex-guard.ts",
  );
  const bridgeUrl = pathToFileURL(bridgePath).href;
  assert.equal(isDirectGuardBridgeExecution(bridgePath, bridgeUrl), true);
  assert.equal(
    isDirectGuardBridgeExecution(
      bridgePath,
      `${bridgeUrl}?tsx-namespace=fixture#loader`,
    ),
    true,
  );
  assert.equal(
    isDirectGuardBridgeExecution(
      join(sourceRoot, ".claude", "hooks", "provenance.ts"),
      bridgeUrl,
    ),
    false,
  );
  if (process.platform !== "win32") {
    const aliasRoot = mkdtempSync(join(tmpdir(), "Spark ADW guard alias "));
    try {
      const aliasPath = join(aliasRoot, "run-codex-guard.ts");
      symlinkSync(bridgePath, aliasPath);
      assert.equal(isDirectGuardBridgeExecution(aliasPath, bridgeUrl), true);
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  }
});
