import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type CommandHook = {
  type: string;
  command: string;
  args: string[];
  timeout: number;
  statusMessage?: string;
  asyncRewake?: boolean;
  [key: string]: unknown;
};

type HookRegistration = {
  matcher?: string;
  hooks: CommandHook[];
  [key: string]: unknown;
};

type ClaudeSettings = {
  hooks: Record<string, HookRegistration[]>;
};

const expectedProvenanceEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

const projectPlaceholder = "${CLAUDE_PROJECT_DIR}";
const provenanceHookPath = `${projectPlaceholder}/.claude/hooks/provenance.ts`;
const provenanceRuntimePath =
  `${projectPlaceholder}/.agents/provenance/node_modules/tsx/dist/cli.mjs`;
const guardHookPath = `${projectPlaceholder}/.claude/hooks/run-codex-guard.ts`;
const guardRuntimePath = `${projectPlaceholder}/node_modules/tsx/dist/cli.mjs`;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const expectedGuards = [
  {
    eventName: "PreToolUse",
    registration: {
      matcher: "Bash|Edit|Write|apply_patch",
      hooks: [
        {
          type: "command",
          command: "node",
          args: [guardRuntimePath, guardHookPath, "agent_runtime_policy"],
          timeout: 5,
          statusMessage: "Checking Codex agent runtime policy",
        },
      ],
    },
  },
  {
    eventName: "PreToolUse",
    registration: {
      matcher: "apply_patch|Edit|Write",
      hooks: [
        {
          type: "command",
          command: "node",
          args: [guardRuntimePath, guardHookPath, "comment_guard"],
          timeout: 5,
          statusMessage: "Checking comment policy",
        },
      ],
    },
  },
  {
    eventName: "PostToolUse",
    registration: {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "node",
          args: [guardRuntimePath, guardHookPath, "task_completion_ping"],
          timeout: 10,
          statusMessage: "Capturing managed task completion",
        },
      ],
    },
  },
  {
    eventName: "Stop",
    registration: {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: "node",
          args: [guardRuntimePath, guardHookPath, "managed_plan_stop_gate"],
          timeout: 10,
          statusMessage: "Checking managed plan completeness",
        },
      ],
    },
  },
] as const;

function loadSettings(): ClaudeSettings {
  return JSON.parse(
    readFileSync(join(projectRoot, ".claude", "settings.json"), "utf8"),
  ) as ClaudeSettings;
}

function isProvenanceRegistration(registration: HookRegistration): boolean {
  return registration.hooks.some((hook) =>
    hook.args.includes(provenanceHookPath),
  );
}

function provenanceRegistrations(
  settings: ClaudeSettings,
  eventName: string,
): HookRegistration[] {
  return (settings.hooks[eventName] ?? []).filter(isProvenanceRegistration);
}

test("registers exactly eleven provenance events", () => {
  const settings = loadSettings();
  assert.equal(expectedProvenanceEvents.length, 11);
  assert.deepEqual(
    Object.keys(settings.hooks).sort(),
    [...expectedProvenanceEvents].sort(),
  );
  for (const eventName of expectedProvenanceEvents) {
    assert.equal(provenanceRegistrations(settings, eventName).length, 1);
  }
  const total = Object.entries(settings.hooks).reduce(
    (count, [eventName]) =>
      count + provenanceRegistrations(settings, eventName).length,
    0,
  );
  assert.equal(total, 11);
});

test("preserves all four Codex guard bridges byte-for-byte in configuration", () => {
  const settings = loadSettings();
  const actualGuards = Object.entries(settings.hooks).flatMap(
    ([eventName, registrations]) =>
      registrations
        .filter((registration) => !isProvenanceRegistration(registration))
        .map((registration) => ({ eventName, registration })),
  );

  assert.equal(actualGuards.length, 4);
  assert.equal(JSON.stringify(actualGuards), JSON.stringify(expectedGuards));
});

test("uses supported five-second asynchronous provenance handlers", () => {
  const settings = loadSettings();
  for (const eventName of expectedProvenanceEvents) {
    const [registration] = provenanceRegistrations(settings, eventName);
    assert.ok(registration);
    assert.deepEqual(Object.keys(registration), ["hooks"]);
    assert.equal(registration.hooks.length, 1);
    assert.deepEqual(registration.hooks[0], {
      type: "command",
      command: "node",
      args: [provenanceRuntimePath, provenanceHookPath],
      timeout: 5,
      asyncRewake: true,
    });
  }
});

test("omits every excluded provenance event", () => {
  const settings = loadSettings();
  const registeredProvenanceEvents = Object.entries(settings.hooks)
    .filter(([, registrations]) =>
      registrations.some(isProvenanceRegistration),
    )
    .map(([eventName]) => eventName)
    .sort();
  assert.deepEqual(registeredProvenanceEvents, [...expectedProvenanceEvents].sort());
  assert.equal(
    Object.values(settings.hooks)
      .flat()
      .filter(isProvenanceRegistration).length,
    expectedProvenanceEvents.length,
  );
});
