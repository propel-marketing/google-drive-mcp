import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { ClaudeCodeProvenanceAdapter } from "../claude-code-provenance-adapter.js";
import { CodexProvenanceAdapter } from "../codex-provenance-adapter.js";
import {
  captureProvenanceEvent,
  neverControlsWorkflow,
} from "../capture-provenance-event.js";
import { ProvenanceJsonlMirror } from "../mirror-provenance-jsonl.js";
import { ProvenanceCaptureConfigSchema } from "../provenance-schemas.js";
import type {
  HarnessId,
  ProvenanceCaptureConfig,
  RedactedProvenanceEvent,
  ValidatedProvenanceEvent,
} from "../provenance-schemas.js";
import { ProvenanceRedactor } from "../redact-provenance-event.js";
import { ProvenanceActorResolver } from "../resolve-provenance-actor.js";
import { sanitizeProvenanceDiagnosticMessage } from "../sanitize-provenance-diagnostic.js";

const provenanceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(provenanceRoot, "..", "..");
const tsxCli = resolve(provenanceRoot, "node_modules", "tsx", "dist", "cli.mjs");

const recordedAt = "2026-07-18T12:00:00.000Z";
function adapter(harness: HarnessId) {
  return harness === "codex"
    ? new CodexProvenanceAdapter()
    : new ClaudeCodeProvenanceAdapter();
}

function normalize(
  harness: HarnessId,
  overrides: Record<string, unknown> = {},
): ValidatedProvenanceEvent {
  return adapter(harness).normalize(
    {
      session_id: `${harness}-session`,
      cwd: "PROJECT_ROOT",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
      tool_response: { status: "success" },
      tool_use_id: "tool-use-shared",
      agent_id: "agent-1",
      agent_type: "builder",
      ...overrides,
    },
    recordedAt,
  );
}

function captureConfig(overrides: {
  ledger?: string;
  jsonlDirectory?: string;
  enabled?: boolean;
} = {}): ProvenanceCaptureConfig {
  return ProvenanceCaptureConfigSchema.parse({
    schemaVersion: 1,
    enabled: overrides.enabled ?? true,
    neverControlsWorkflow: true,
    maxFieldBytes: 65_536,
    paths: {
      ledger: overrides.ledger ?? ".agents/data/provenance/provenance.db",
      jsonlDirectory:
        overrides.jsonlDirectory ?? ".agents/data/provenance/jsonl",
      actorStateDirectory: ".agents/data/provenance/actors",
      modelCacheDirectory: ".agents/data/provenance/models",
    },
    jsonl: {
      lockRetryCount: 1,
      lockRetryDelayMs: 0,
      staleLockMs: 30_000,
    },
    embeddings: {
      modelId: "Xenova/all-MiniLM-L6-v2",
      pooling: "mean",
      normalize: true,
      runInsideCaptureHook: false,
    },
    captureEvents: {
      codex: [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "SubagentStart",
        "SubagentStop",
        "Stop",
      ],
      "claude-code": [
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
      ],
    },
  });
}

async function temporaryProject(
  overrides: Parameters<typeof captureConfig>[0] = {},
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "spark-capture-contract-"));
  assert.equal(resolve(projectRoot).startsWith(resolve(tmpdir())), true);
  const configDirectory = join(projectRoot, ".agents", "provenance");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "provenance.config.json"),
    JSON.stringify(captureConfig(overrides)),
  );
  return projectRoot;
}

async function withProjectRoot<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = process.env.PROVENANCE_PROJECT_ROOT;
  process.env.PROVENANCE_PROJECT_ROOT = projectRoot;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.PROVENANCE_PROJECT_ROOT;
    else process.env.PROVENANCE_PROJECT_ROOT = previous;
  }
}

async function allFileContents(root: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) contents.push(await readFile(entryPath));
    }
  }
  await visit(root);
  return contents;
}

async function persistedJsonlEvents(
  projectRoot: string,
  harness: HarnessId,
  sessionId: string,
): Promise<RedactedProvenanceEvent[]> {
  const sessionToken = createHash("sha256").update(sessionId).digest("hex");
  const path = join(
    projectRoot,
    ".agents",
    "data",
    "provenance",
    "jsonl",
    harness,
    `session-${sessionToken}.jsonl`,
  );
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RedactedProvenanceEvent);
}

function persistedSqliteEvents(projectRoot: string): RedactedProvenanceEvent[] {
  const ledger = new Database(
    join(projectRoot, ".agents", "data", "provenance", "provenance.db"),
    { readonly: true },
  );
  try {
    const rows = ledger
      .prepare("SELECT redacted_event_json FROM provenance_events ORDER BY sequence")
      .all() as Array<{ redacted_event_json: string }>;
    return rows.map(
      ({ redacted_event_json }) =>
        JSON.parse(redacted_event_json) as RedactedProvenanceEvent,
    );
  } finally {
    ledger.close();
  }
}

async function invokeHook(
  hookPath: string,
  projectRoot: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [tsxCli, hookPath], {
      cwd: repositoryRoot,
      env: { ...process.env, PROVENANCE_PROJECT_ROOT: projectRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolveProcess({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function redactForJsonl(event: ValidatedProvenanceEvent): RedactedProvenanceEvent {
  return new ProvenanceRedactor({
    projectRoot: "PROJECT_ROOT",
    userHome: "USER_HOME",
    temporaryDirectory: "TEMP_DIR",
    maxFieldBytes: 65_536,
  }).redact(event, new ProvenanceActorResolver().resolve(event));
}

test("normalizes equivalent harness tool events", () => {
  const codex = normalize("codex", { session_id: "shared-session" });
  const claude = normalize("claude-code", { session_id: "shared-session" });

  assert.equal(codex.harness, "codex");
  assert.equal(claude.harness, "claude-code");
  for (const field of [
    "eventName",
    "sessionId",
    "source",
    "role",
    "agentId",
    "agentType",
    "toolName",
    "toolUseId",
    "cwd",
  ] as const) {
    assert.equal(codex[field], claude[field], field);
  }
  assert.deepEqual(codex.eventData, claude.eventData);
});

test("prefers explicit actor identity and clears stopped actors", async (t) => {
  const actorStateDirectory = await mkdtemp(join(tmpdir(), "spark-actors-"));
  t.after(() => rm(actorStateDirectory, { recursive: true, force: true }));
  const resolver = new ProvenanceActorResolver({ actorStateDirectory });

  const mislabeledSource = resolver.resolve(
    normalize("codex", {
      hook_event_name: "SessionStart",
      source: "startup",
      agent_id: undefined,
      agent_type: undefined,
    }),
  );
  assert.equal(mislabeledSource.role, "orchestrator");

  const leafStart = normalize("claude-code", {
    hook_event_name: "SubagentStart",
    source: "explore",
    agent_id: "leaf-1",
    agent_type: "explore",
  });
  assert.equal(resolver.resolve(leafStart).role, "explore");

  const parentTool = normalize("claude-code", {
    source: "main",
    agent_id: undefined,
    agent_type: undefined,
  });
  assert.equal(resolver.resolve(parentTool).role, "orchestrator");

  const leafStop = normalize("claude-code", {
    hook_event_name: "SubagentStop",
    source: "explore",
    agent_id: "leaf-1",
    agent_type: "explore",
  });
  assert.equal(resolver.resolve(leafStop).agentId, "leaf-1");
  assert.equal(
    resolver.resolve(
      normalize("claude-code", {
        hook_event_name: "SubagentStop",
        source: "main",
        agent_id: undefined,
        agent_type: undefined,
      }),
    ).role,
    "orchestrator",
  );

  const firstSensitiveId = "sk-proj-SYNTHETICACTORIDENTITY111";
  const secondSensitiveId = "sk-proj-SYNTHETICACTORIDENTITY222";
  for (const agentId of [firstSensitiveId, secondSensitiveId]) {
    resolver.resolve(
      normalize("claude-code", {
        hook_event_name: "SubagentStart",
        source: "main",
        agent_id: agentId,
        agent_type: "builder",
      }),
    );
  }
  resolver.resolve(
    normalize("claude-code", {
      hook_event_name: "SubagentStop",
      source: "main",
      agent_id: firstSensitiveId,
      agent_type: "builder",
    }),
  );

  const stateNames = (await readdir(actorStateDirectory)).filter((name) =>
    name.endsWith(".json"),
  );
  const stateName = (
    await Promise.all(
      stateNames.map(async (name) => ({
        name,
        state: JSON.parse(await readFile(join(actorStateDirectory, name), "utf8")) as {
          actors: unknown[];
        },
      })),
    )
  ).find(({ state }) => state.actors.length === 1)?.name;
  assert.ok(stateName);
  const stateAfterFirstStop = await readFile(join(actorStateDirectory, stateName), "utf8");
  const parsedState = JSON.parse(stateAfterFirstStop) as { actors: unknown[] };
  assert.equal(parsedState.actors.length, 1);
  assert.equal(stateAfterFirstStop.includes(firstSensitiveId), false);
  assert.equal(stateAfterFirstStop.includes(secondSensitiveId), false);

  resolver.resolve(
    normalize("claude-code", {
      hook_event_name: "SubagentStop",
      source: "main",
      agent_id: secondSensitiveId,
      agent_type: "builder",
    }),
  );
  const finalState = JSON.parse(
    await readFile(join(actorStateDirectory, stateName), "utf8"),
  ) as { actors: unknown[] };
  assert.equal(finalState.actors.length, 0);
});

test("preserves repeated lifecycle deliveries", () => {
  for (const harness of ["codex", "claude-code"] as const) {
    const payload = {
      session_id: `${harness}-repeat-session`,
      cwd: "PROJECT_ROOT",
      hook_event_name: "SessionStart",
    };
    const first = adapter(harness).normalize(payload, recordedAt);
    const second = adapter(harness).normalize(payload, recordedAt);
    assert.notEqual(first.eventId, second.eventId);
    assert.deepEqual(first.eventData, second.eventData);
  }
});

test("keeps JSONL locks owner-safe under contention", async (t) => {
  const jsonlDirectory = await mkdtemp(join(tmpdir(), "spark-jsonl-lock-"));
  t.after(() => rm(jsonlDirectory, { recursive: true, force: true }));
  const appender = new ProvenanceJsonlMirror(jsonlDirectory, {
    lockRetryCount: 0,
    lockRetryDelayMs: 0,
    staleLockMs: 60_000,
  });
  const sessionId = "lock-session";
  const events = Array.from({ length: 12 }, (_, index) =>
    redactForJsonl(
      normalize("codex", {
        session_id: sessionId,
        hook_event_name: "SessionStart",
        tool_use_id: undefined,
        agent_id: undefined,
        agent_type: undefined,
        sequence_hint: index,
      }),
    ),
  );
  await Promise.all(events.map((event) => appender.append(event)));

  const destination = join(
    jsonlDirectory,
    "codex",
    `session-${createHash("sha256").update(sessionId).digest("hex")}.jsonl`,
  );
  const lines = (await readFile(destination, "utf8")).trim().split("\n");
  assert.equal(lines.length, events.length);
  assert.equal(new Set(lines.map((line) => JSON.parse(line).eventId)).size, events.length);
  await assert.rejects(access(`${destination}.lock`));

  const foreignLock = `${destination}.lock`;
  const foreignContents = JSON.stringify({ token: randomUUID() });
  await writeFile(foreignLock, foreignContents);
  await assert.rejects(appender.append(events[0]!));
  assert.equal(await readFile(foreignLock, "utf8"), foreignContents);
});

test("reports JSONL-only SQLite-only and no-store outcomes", async (t) => {
  const scenarios = [
    {
      name: "JSONL-only",
      ledger: ".agents/data/sqlite-blocker",
      jsonlDirectory: ".agents/data/jsonl-ok",
      prepare: async (root: string) =>
        mkdir(join(root, ".agents", "data", "sqlite-blocker"), { recursive: true }),
      expectedStatus: "degraded",
      receiptExpected: false,
    },
    {
      name: "SQLite-only",
      ledger: ".agents/data/sqlite-ok/provenance.db",
      jsonlDirectory: ".agents/data/jsonl-blocker",
      prepare: async (root: string) => {
        await mkdir(join(root, ".agents", "data"), { recursive: true });
        await writeFile(join(root, ".agents", "data", "jsonl-blocker"), "file");
      },
      expectedStatus: "degraded",
      receiptExpected: true,
    },
    {
      name: "no-store",
      ledger: ".agents/data/sqlite-blocker",
      jsonlDirectory: ".agents/data/jsonl-blocker",
      prepare: async (root: string) => {
        await mkdir(join(root, ".agents", "data", "sqlite-blocker"), {
          recursive: true,
        });
        await writeFile(join(root, ".agents", "data", "jsonl-blocker"), "file");
      },
      expectedStatus: "unrecorded",
      receiptExpected: false,
    },
  ] as const;

  for (const harness of ["codex", "claude-code"] as const) {
    for (const scenario of scenarios) {
      await t.test(`${harness} ${scenario.name}`, async (t) => {
        const projectRoot = await temporaryProject(scenario);
        t.after(() => rm(projectRoot, { recursive: true, force: true }));
        await scenario.prepare(projectRoot);
        const fixtureSecret = `sk-proj-SYNTHETICCAPTURE${harness.replace("-", "")}123456`;
        const result = await withProjectRoot(projectRoot, () =>
          captureProvenanceEvent(harness, {
            session_id: `${harness}-${scenario.name}`,
            cwd: projectRoot,
            hook_event_name: "SessionStart",
            prompt: fixtureSecret,
          }),
        );

        assert.equal(result.status, scenario.expectedStatus, JSON.stringify(result));
        assert.equal(result.receipt !== undefined, scenario.receiptExpected);
        assert.equal(JSON.stringify(result).includes(fixtureSecret), false);
        for (const contents of await allFileContents(projectRoot)) {
          assert.equal(contents.includes(Buffer.from(fixtureSecret)), false);
        }
      });
    }
  }
});

test("persists a manual PreCompact payload in SQLite and JSONL", async (t) => {
  const projectRoot = await temporaryProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const sessionId = "manual-precompact-session";
  const result = await withProjectRoot(projectRoot, () =>
    captureProvenanceEvent("claude-code", {
      session_id: sessionId,
      transcript_path: join(projectRoot, ".claude", "transcripts", "session.jsonl"),
      cwd: projectRoot,
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    }),
  );

  assert.equal(result.status, "recorded", JSON.stringify(result));
  const [jsonlEvent] = await persistedJsonlEvents(
    projectRoot,
    "claude-code",
    sessionId,
  );
  const [sqliteEvent] = persistedSqliteEvents(projectRoot);
  assert.ok(jsonlEvent);
  assert.ok(sqliteEvent);
  assert.equal(jsonlEvent.eventId, result.eventId);
  assert.equal(sqliteEvent.eventId, result.eventId);
  assert.equal(jsonlEvent.eventName, "PreCompact");
  assert.equal(sqliteEvent.eventName, "PreCompact");
  assert.equal(jsonlEvent.harness, "claude-code");
  assert.deepEqual(sqliteEvent, jsonlEvent);
  assert.equal(
    Object.hasOwn(jsonlEvent.eventData as object, "custom_instructions"),
    false,
  );
});

test("persists a safe rejection marker without raw payload or actor mutation", async (t) => {
  const projectRoot = await temporaryProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const actorDirectory = join(
    projectRoot,
    ".agents",
    "data",
    "provenance",
    "actors",
  );
  await mkdir(actorDirectory, { recursive: true });
  const actorSentinel = join(actorDirectory, "existing-state.sentinel");
  await writeFile(actorSentinel, "unchanged", "utf8");
  const sessionId = "rejected-precompact-session";
  const rejectedSecret = "github_pat_SYNTHETICREJECTIONSECRET1234567890";
  const result = await withProjectRoot(projectRoot, () =>
    captureProvenanceEvent("claude-code", {
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: { invalid: true },
      rejected_secret: rejectedSecret,
    }),
  );

  assert.equal(result.status, "unrecorded", JSON.stringify(result));
  assert.equal(result.diagnostics[0]?.stage, "normalize");
  assert.equal(result.receipt, undefined);
  assert.ok(result.rejectionMarkerOutcome?.receipt);
  assert.notEqual(result.eventId, result.rejectionMarkerOutcome.eventId);
  const jsonlEvents = await persistedJsonlEvents(
    projectRoot,
    "claude-code",
    sessionId,
  );
  const sqliteEvents = persistedSqliteEvents(projectRoot);
  assert.equal(jsonlEvents.length, 1);
  assert.equal(sqliteEvents.length, 1);
  const marker = jsonlEvents[0]!;
  assert.deepEqual(sqliteEvents[0], marker);
  assert.equal(marker.eventId, result.rejectionMarkerOutcome.eventId);
  assert.equal(result.rejectionMarkerOutcome.sessionId, sessionId);
  assert.equal(result.rejectionMarkerOutcome.status, "recorded");
  assert.equal(
    result.rejectionMarkerOutcome.receipt.eventId,
    result.rejectionMarkerOutcome.eventId,
  );
  assert.equal(result.rejectionMarkerOutcome.integrityWarning, undefined);
  assert.equal(marker.source, "provenance-validation");
  assert.equal(marker.role, "unknown");
  assert.equal(marker.eventName, "PreCompact");
  assert.equal(
    (marker.eventData as { markerType?: unknown }).markerType,
    "hook-validation-rejection",
  );
  assert.equal(
    (marker.eventData as { captureStatus?: unknown }).captureStatus,
    "unrecorded",
  );
  assert.deepEqual(await readdir(actorDirectory), ["existing-state.sentinel"]);
  assert.equal(await readFile(actorSentinel, "utf8"), "unchanged");
  assert.equal(JSON.stringify(result).includes(rejectedSecret), false);
  for (const contents of await allFileContents(projectRoot)) {
    assert.equal(contents.includes(Buffer.from(rejectedSecret)), false);
  }

  const invalidIdentitySecret = "sk-proj-SYNTHETICINVALIDIDENTITY123456";
  const invalidIdentity = await withProjectRoot(projectRoot, () =>
    captureProvenanceEvent("claude-code", {
      session_id: "invalid-identity-session",
      hook_event_name: "PreCompact",
      custom_instructions: { invalid: true },
      rejected_secret: invalidIdentitySecret,
    }),
  );
  assert.equal(invalidIdentity.status, "unrecorded");
  assert.equal(invalidIdentity.receipt, undefined);
  assert.equal(invalidIdentity.rejectionMarkerOutcome, undefined);
  assert.equal(persistedSqliteEvents(projectRoot).length, 1);
  assert.equal(JSON.stringify(invalidIdentity).includes(invalidIdentitySecret), false);
  for (const contents of await allFileContents(projectRoot)) {
    assert.equal(contents.includes(Buffer.from(invalidIdentitySecret)), false);
  }
});

test("reports rejection marker store outcomes", async (t) => {
  const scenarios = [
    {
      name: "both stores",
      config: {},
      prepare: async (_root: string) => undefined,
      expectedStatus: "recorded",
      jsonlExpected: true,
      sqliteExpected: true,
      warningPattern: undefined,
    },
    {
      name: "JSONL-only",
      config: { ledger: ".agents/data/sqlite-blocker" },
      prepare: async (root: string) =>
        mkdir(join(root, ".agents", "data", "sqlite-blocker"), {
          recursive: true,
        }),
      expectedStatus: "degraded",
      jsonlExpected: true,
      sqliteExpected: false,
      warningPattern: /only one local store/u,
    },
    {
      name: "SQLite-only",
      config: { jsonlDirectory: ".agents/data/jsonl-blocker" },
      prepare: async (root: string) => {
        await mkdir(join(root, ".agents", "data"), { recursive: true });
        await writeFile(join(root, ".agents", "data", "jsonl-blocker"), "file");
      },
      expectedStatus: "degraded",
      jsonlExpected: false,
      sqliteExpected: true,
      warningPattern: /only one local store/u,
    },
    {
      name: "neither store",
      config: {
        ledger: ".agents/data/sqlite-blocker",
        jsonlDirectory: ".agents/data/jsonl-blocker",
      },
      prepare: async (root: string) => {
        await mkdir(join(root, ".agents", "data", "sqlite-blocker"), {
          recursive: true,
        });
        await writeFile(join(root, ".agents", "data", "jsonl-blocker"), "file");
      },
      expectedStatus: "unrecorded",
      jsonlExpected: false,
      sqliteExpected: false,
      warningPattern: /either local store/u,
    },
    {
      name: "disabled",
      config: { enabled: false },
      prepare: async (_root: string) => undefined,
      expectedStatus: "unrecorded",
      jsonlExpected: false,
      sqliteExpected: false,
      warningPattern: /capture is disabled/u,
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const projectRoot = await temporaryProject(scenario.config);
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      await scenario.prepare(projectRoot);
      const sessionId = `rejection-${scenario.name.replaceAll(" ", "-")}`;
      const rejectedSecret =
        "github_pat_SYNTHETICMARKEROUTCOMESECRET1234567890";
      const result = await withProjectRoot(projectRoot, () =>
        captureProvenanceEvent("claude-code", {
          session_id: sessionId,
          cwd: projectRoot,
          hook_event_name: "PreCompact",
          custom_instructions: { invalid: true },
          rejected_secret: rejectedSecret,
        }),
      );

      assert.equal(result.status, "unrecorded", JSON.stringify(result));
      assert.equal(result.receipt, undefined);
      assert.equal(result.diagnostics[0]?.stage, "normalize");
      const markerOutcome = result.rejectionMarkerOutcome;
      assert.ok(markerOutcome);
      assert.notEqual(markerOutcome.eventId, result.eventId);
      assert.equal(markerOutcome.sessionId, sessionId);
      assert.equal(markerOutcome.status, scenario.expectedStatus);
      assert.equal(markerOutcome.receipt !== undefined, scenario.sqliteExpected);
      if (scenario.warningPattern === undefined) {
        assert.equal(markerOutcome.integrityWarning, undefined);
      } else {
        assert.match(markerOutcome.integrityWarning ?? "", scenario.warningPattern);
      }

      if (scenario.jsonlExpected) {
        const [jsonlMarker] = await persistedJsonlEvents(
          projectRoot,
          "claude-code",
          sessionId,
        );
        assert.equal(jsonlMarker?.eventId, markerOutcome.eventId);
      }
      if (scenario.sqliteExpected) {
        const [sqliteMarker] = persistedSqliteEvents(projectRoot);
        assert.equal(sqliteMarker?.eventId, markerOutcome.eventId);
        assert.equal(markerOutcome.receipt?.eventId, markerOutcome.eventId);
      }
      assert.equal(JSON.stringify(result).includes(rejectedSecret), false);
      for (const contents of await allFileContents(projectRoot)) {
        assert.equal(contents.includes(Buffer.from(rejectedSecret)), false);
      }
    });
  }
});

test("reports both-store rejection marker diagnostics passively", async (t) => {
  const projectRoot = await temporaryProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const sessionId = "passive-rejection-session";
  const markerSession = `sha256:${createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16)}`;
  const rejectedRawValue = "REJECTED_BOTH_STORE_RAW_VALUE";
  const rejectedSecret = "sk-proj-SYNTHETICPASSIVESECRET123456";
  const hookResult = await invokeHook(
    resolve(repositoryRoot, ".claude", "hooks", "provenance.ts"),
    projectRoot,
    JSON.stringify({
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "PreCompact",
      custom_instructions: [rejectedRawValue],
      rejected_secret: rejectedSecret,
    }),
  );

  assert.equal(hookResult.code, 0, hookResult.stderr);
  assert.equal(hookResult.stdout, "");
  assert.match(hookResult.stderr, /captureStatus="unrecorded"/u);
  assert.match(hookResult.stderr, /markerCaptureStatus="recorded"/u);
  const originalEventId = hookResult.stderr.match(
    /originalEventId="([^"]+)"/u,
  )?.[1];
  assert.ok(originalEventId);
  assert.match(
    hookResult.stderr,
    new RegExp(`markerSession="${markerSession}"`, "u"),
  );
  assert.match(hookResult.stderr, /markerReceiptSequence=1/u);
  assert.match(
    hookResult.stderr,
    new RegExp(`markerReceiptSession="${markerSession}"`, "u"),
  );
  assert.equal(hookResult.stderr.includes(sessionId), false);
  assert.equal(hookResult.stderr.includes(rejectedRawValue), false);
  assert.equal(hookResult.stderr.includes(rejectedSecret), false);
  const [marker] = await persistedJsonlEvents(
    projectRoot,
    "claude-code",
    sessionId,
  );
  assert.ok(marker);
  assert.match(
    hookResult.stderr,
    new RegExp(`markerEventId="${marker.eventId}"`, "u"),
  );
  assert.notEqual(originalEventId, marker.eventId);
  assert.equal(marker.source, "provenance-validation");
  assert.equal(marker.role, "unknown");
  assert.equal(persistedSqliteEvents(projectRoot).length, 1);
  for (const contents of await allFileContents(projectRoot)) {
    assert.equal(contents.includes(Buffer.from(rejectedSecret)), false);
  }
});

test("reports JSONL-only rejection marker diagnostics", async (t) => {
  const projectRoot = await temporaryProject({
    ledger: ".agents/data/sqlite-blocker",
  });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, ".agents", "data", "sqlite-blocker"), {
    recursive: true,
  });
  const sessionId = "jsonl-only-hook-rejection-session";
  const markerSession = `sha256:${createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16)}`;
  const rejectedRawValue = "REJECTED_JSONL_ONLY_RAW_VALUE";
  const rejectedSecret = "github_pat_SYNTHETICJSONLHOOKSECRET1234567890";
  const hookResult = await invokeHook(
    resolve(repositoryRoot, ".claude", "hooks", "provenance.ts"),
    projectRoot,
    JSON.stringify({
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "PreCompact",
      custom_instructions: [rejectedRawValue],
      rejected_secret: rejectedSecret,
    }),
  );

  assert.equal(hookResult.code, 0, hookResult.stderr);
  assert.equal(hookResult.stdout, "");
  assert.equal(hookResult.stderr.trim().split("\n").length, 1);
  assert.match(hookResult.stderr, /captureStatus="unrecorded"/u);
  assert.match(hookResult.stderr, /markerCaptureStatus="degraded"/u);
  const originalEventId = hookResult.stderr.match(
    /originalEventId="([^"]+)"/u,
  )?.[1];
  assert.ok(originalEventId);
  assert.match(
    hookResult.stderr,
    new RegExp(`markerSession="${markerSession}"`, "u"),
  );
  assert.equal(hookResult.stderr.includes("markerReceiptSequence="), false);
  assert.equal(hookResult.stderr.includes("markerReceiptSession="), false);
  assert.equal(hookResult.stderr.includes(sessionId), false);
  assert.equal(hookResult.stderr.includes(rejectedRawValue), false);
  assert.equal(hookResult.stderr.includes(rejectedSecret), false);
  assert.ok(Buffer.byteLength(hookResult.stderr, "utf8") < 2_048);

  const [marker] = await persistedJsonlEvents(
    projectRoot,
    "claude-code",
    sessionId,
  );
  assert.ok(marker);
  assert.match(
    hookResult.stderr,
    new RegExp(`markerEventId="${marker.eventId}"`, "u"),
  );
  assert.notEqual(originalEventId, marker.eventId);
  for (const contents of await allFileContents(projectRoot)) {
    assert.equal(contents.includes(Buffer.from(rejectedSecret)), false);
  }
});

test("never emits a workflow decision", async (t) => {
  assert.equal(neverControlsWorkflow, true);
  for (const harness of ["codex", "claude-code"] as const) {
    await t.test(harness, async (t) => {
      const projectRoot = await temporaryProject();
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      const success = await withProjectRoot(projectRoot, () =>
        captureProvenanceEvent(harness, {
          session_id: `${harness}-success`,
          cwd: projectRoot,
          hook_event_name: "SessionStart",
        }),
      );
      assert.equal(success.status, "recorded", JSON.stringify(success));
      assert.deepEqual(
        Object.keys(success).sort(),
        ["diagnostics", "eventId", "receipt", "status"].sort(),
      );

      const malformedSecret = "sk-proj-SYNTHETICMALFORMED123456";
      const malformed = await withProjectRoot(projectRoot, () =>
        captureProvenanceEvent(harness, {
          session_id: `${harness}-malformed`,
          hook_event_name: "SessionStart",
          prompt: malformedSecret,
        }),
      );
      assert.equal(malformed.status, "unrecorded");
      assert.deepEqual(
        Object.keys(malformed).sort(),
        ["diagnostics", "eventId", "integrityWarning", "status"].sort(),
      );
      assert.equal(JSON.stringify(malformed).includes(malformedSecret), false);
    });
  }
});

test("missing and malformed config remain passive at real hook entrypoints", async (t) => {
  const hookPaths = [
    resolve(repositoryRoot, ".claude", "hooks", "provenance.ts"),
    resolve(repositoryRoot, ".codex", "hooks", "provenance.ts"),
  ];
  for (const configState of ["missing", "malformed"] as const) {
    const projectRoot = await mkdtemp(join(tmpdir(), `spark-hook-${configState}-`));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    if (configState === "malformed") {
      const configPath = join(projectRoot, ".agents", "provenance", "provenance.config.json");
      await mkdir(join(projectRoot, ".agents", "provenance"), { recursive: true });
      await writeFile(configPath, "{broken-config", "utf8");
    }
    for (const hookPath of hookPaths) {
      const result = await invokeHook(
        hookPath,
        projectRoot,
        JSON.stringify({
          session_id: `${configState}-session`,
          cwd: projectRoot,
          hook_event_name: "SessionStart",
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
      assert.match(result.stderr, /Provenance hook diagnostic/u);
      if (configState === "missing") {
        assert.match(result.stderr, /<PROJECT_ROOT>/u);
      }
      assert.match(result.stderr, /Safe next step/u);
      assert.equal(result.stderr.includes(projectRoot), false, result.stderr);
    }
  }
});

test("malformed hook input is passive and bounded at both entrypoints", async (t) => {
  const projectRoot = await temporaryProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const malformed = '{"token":"github_pat_SYNTHETICSECRET1234567890"';
  for (const hookPath of [
    resolve(repositoryRoot, ".claude", "hooks", "provenance.ts"),
    resolve(repositoryRoot, ".codex", "hooks", "provenance.ts"),
  ]) {
    const result = await invokeHook(hookPath, projectRoot, malformed);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
    assert.equal(result.stderr.includes("SYNTHETICSECRET"), false);
    assert.ok(Buffer.byteLength(result.stderr, "utf8") < 2_048);
  }
});

test("corrupt actor state fails closed without overwrite or persisted misattribution", async (t) => {
  const projectRoot = await temporaryProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const start = await withProjectRoot(projectRoot, () =>
    captureProvenanceEvent("claude-code", {
      session_id: "corrupt-actor-session",
      cwd: projectRoot,
      hook_event_name: "SubagentStart",
      source: "explore",
      agent_id: "leaf-1",
      agent_type: "explore",
    }),
  );
  assert.equal(start.status, "recorded", JSON.stringify(start));
  const actorDirectory = join(projectRoot, ".agents", "data", "provenance", "actors");
  const [stateName] = (await readdir(actorDirectory)).filter((name) => name.endsWith(".json"));
  assert.ok(stateName);
  const statePath = join(actorDirectory, stateName);
  await writeFile(statePath, "{broken", "utf8");

  const stop = await withProjectRoot(projectRoot, () =>
    captureProvenanceEvent("claude-code", {
      session_id: "corrupt-actor-session",
      cwd: projectRoot,
      hook_event_name: "SubagentStop",
      source: "main",
    }),
  );
  assert.equal(stop.status, "unrecorded", JSON.stringify(stop));
  assert.equal(stop.diagnostics[0]?.stage, "actor");
  assert.equal(stop.diagnostics[0]?.errorCode, "ACTOR_STATE_UNREADABLE");
  assert.match(stop.diagnostics[0]?.sanitizedMessage ?? "", /Safe next step/u);
  assert.equal(await readFile(statePath, "utf8"), "{broken");

  const jsonlDirectory = join(projectRoot, ".agents", "data", "provenance", "jsonl", "claude-code");
  const [jsonlName] = await readdir(jsonlDirectory);
  const lines = (await readFile(join(jsonlDirectory, jsonlName!), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('"eventName":"SubagentStop"'), false);
});

test("diagnostic path tokenization covers Windows WSL and POSIX forms", () => {
  const windowsRoot = "D:\\My Code Projects\\Propel-ADW";
  assert.equal(
    sanitizeProvenanceDiagnosticMessage(`open ${windowsRoot}\\missing.json`, { projectRoot: windowsRoot }),
    "open <PROJECT_ROOT>\\missing.json",
  );
  assert.equal(
    sanitizeProvenanceDiagnosticMessage("open /mnt/d/My Code Projects/Propel-ADW/missing.json", { projectRoot: windowsRoot }),
    "open <PROJECT_ROOT>/missing.json",
  );
  const posixRoot = "/Users/tester/Projects/Propel-ADW";
  assert.equal(
    sanitizeProvenanceDiagnosticMessage(`open ${posixRoot}/missing.json`, { projectRoot: posixRoot }),
    "open <PROJECT_ROOT>/missing.json",
  );
});
