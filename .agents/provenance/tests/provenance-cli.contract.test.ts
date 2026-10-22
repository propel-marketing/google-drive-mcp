import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  runProvenanceCli,
  type ProvenanceLedgerRecoveryServiceFactory,
} from "../provenance-cli.js";
import { ProvenanceLedgerRecoveryService } from "../recover-provenance-ledger.js";
import {
  PROJECT_ROOT,
  TEMP_DIR,
  USER_HOME,
  projectProvenanceStructuredOutput,
} from "../sanitize-provenance-diagnostic.js";
import type {
  ProvenanceLedgerRecoveryResult,
  ProvenanceLedgerSchemaInspection,
} from "../provenance-ledger-schemas.js";
import {
  ProvenanceCaptureConfigSchema,
  type PersistedProvenanceEvent,
  type ProvenanceCaptureConfig,
  type RedactedProvenanceEvent,
} from "../provenance-schemas.js";
import { ProvenanceLedgerWriter } from "../write-provenance-ledger.js";

type CliResult = { code: number; stdout: string; stderr: string };
type CliFixture = { root: string; config: ProvenanceCaptureConfig };
type CliErrorEnvelope = {
  schemaVersion: 1;
  error: {
    code: string;
    cause: string;
    message: string;
    details: Record<string, unknown>;
    nextAction: { code: string; command?: string; message: string };
  };
};

const provenanceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionId = "session-cli";
const eventIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;
const CLI_COMMANDS = [
  "agent-summary",
  "events",
  "export",
  "failures",
  "index",
  "ledger-status",
  "patterns",
  "recover-ledger",
  "search",
  "sessions",
  "similar",
] as const;

const LEGACY_LEDGER_DDL = `
  CREATE TABLE provenance_sessions (
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    initial_cwd TEXT NOT NULL,
    final_cwd TEXT NOT NULL,
    source TEXT,
    integrity_status TEXT NOT NULL,
    PRIMARY KEY (harness, session_id)
  );
  CREATE TABLE provenance_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    source_fingerprint TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    harness TEXT NOT NULL,
    event_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    cwd_tokenized TEXT NOT NULL,
    sanitized_payload_json TEXT NOT NULL,
    redaction_count INTEGER NOT NULL,
    truncated_fields_json TEXT NOT NULL,
    sanitized_payload_sha256 TEXT NOT NULL,
    jsonl_state TEXT NOT NULL,
    embedding_state TEXT NOT NULL
  );
  CREATE TABLE provenance_embeddings (
    event_id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    content_sha256 TEXT NOT NULL,
    embedded_at TEXT NOT NULL
  );
  CREATE TABLE provenance_integrity_issues (
    issue_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
  PRAGMA user_version = 0;
`;

async function createConfiguredRoot(
  t: TestContext,
  name: string,
): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), `provenance-mvp-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = ProvenanceCaptureConfigSchema.parse(
    JSON.parse(
      await readFile(join(provenanceRoot, "provenance.config.json"), "utf8"),
    ) as unknown,
  );
  const configPath = join(
    root,
    ".agents",
    "provenance",
    "provenance.config.json",
  );
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { root, config };
}

async function createFixture(t: TestContext): Promise<CliFixture> {
  const { root, config } = await createConfiguredRoot(t, "cli");

  const writer = new ProvenanceLedgerWriter(join(root, config.paths.ledger));
  try {
    for (const event of fixtureEvents()) writer.insert(event);
  } finally {
    writer.close();
  }
  return { root, config };
}

async function createLegacyRecoveryFixture(t: TestContext): Promise<CliFixture> {
  const { root, config } = await createConfiguredRoot(t, "cli-recovery");
  const ledgerPath = join(root, config.paths.ledger);
  const jsonlPath = join(
    root,
    config.paths.jsonlDirectory,
    "claude-code",
    `${sessionId}.jsonl`,
  );
  await mkdir(dirname(ledgerPath), { recursive: true });
  await mkdir(dirname(jsonlPath), { recursive: true });
  const database = new Database(ledgerPath);
  try {
    database.exec(LEGACY_LEDGER_DDL);
  } finally {
    database.close();
  }
  await writeFile(
    jsonlPath,
    `${fixtureEvents().map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  return { root, config };
}

async function createObservedPartialRecoveryFixture(
  t: TestContext,
): Promise<CliFixture & { jsonlBytes: Map<string, Buffer> }> {
  const { root, config } = await createConfiguredRoot(t, "cli-observed-partial");
  const ledgerPath = join(root, config.paths.ledger);
  const jsonlDirectory = join(root, config.paths.jsonlDirectory);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const database = new Database(ledgerPath);
  try {
    database.exec(LEGACY_LEDGER_DDL);
  } finally {
    database.close();
  }

  const jsonlBytes = new Map<string, Buffer>();
  let validEventCount = 0;
  let invalidRecordCount = 0;
  for (let fileIndex = 0; fileIndex < 7; fileIndex += 1) {
    const validLineCount = fileIndex < 5 ? 20 : 19;
    const lines: string[] = [];
    for (let lineIndex = 0; lineIndex < 45; lineIndex += 1) {
      if (lineIndex < validLineCount) {
        validEventCount += 1;
        const hex = validEventCount.toString(16).padStart(8, "0");
        const eventId = `${hex}-0000-4000-8000-${hex.padStart(12, "0")}`;
        lines.push(JSON.stringify({
          ...provenanceEvent({
            eventId,
            workflowId: "workflow-observed",
            source: "agent-observed",
            eventName: "PostToolUse",
            toolName: "Edit",
            detail: `observed event ${validEventCount}`,
            second: 1,
          }),
          recordedAt: new Date(
            Date.UTC(2026, 6, 20, 12, 0, validEventCount),
          ).toISOString(),
        }));
      } else {
        invalidRecordCount += 1;
        lines.push(`legacy-record-${invalidRecordCount}`);
      }
    }
    const jsonlPath = join(
      jsonlDirectory,
      fileIndex % 2 === 0 ? "codex" : "claude",
      `observed-${fileIndex + 1}.jsonl`,
    );
    await mkdir(dirname(jsonlPath), { recursive: true });
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    await writeFile(jsonlPath, bytes);
    jsonlBytes.set(jsonlPath, bytes);
  }
  assert.equal(validEventCount, 138);
  assert.equal(invalidRecordCount, 177);
  return { root, config, jsonlBytes };
}

async function createBeyondLimitConflictRecoveryFixture(
  t: TestContext,
): Promise<CliFixture & { jsonlPath: string; jsonlBytes: Buffer }> {
  const fixture = await createLegacyRecoveryFixture(t);
  const accepted = provenanceEvent({
    eventId: "00000000-0000-4000-8000-000000000999",
    workflowId: "workflow-beyond-limit-conflict",
    source: "agent-beyond-limit-conflict",
    eventName: "PostToolUse",
    toolName: "Edit",
    detail: "accepted redacted event",
    second: 4,
  });
  const conflicting = {
    ...accepted,
    eventData: { tool_response: "conflicting redacted event" },
    contentSha256: "f".repeat(64),
  };
  const jsonlPath = join(
    fixture.root,
    fixture.config.paths.jsonlDirectory,
    "codex",
    "beyond-limit-conflict.jsonl",
  );
  await mkdir(dirname(jsonlPath), { recursive: true });
  const jsonlBytes = Buffer.from(
    `${[
      ...Array.from(
        { length: 100 },
        (_, index) => `{not-json-CLI_RAW_RECORD_${index}`,
      ),
      JSON.stringify(accepted),
      JSON.stringify(conflicting),
    ].join("\n")}\n`,
    "utf8",
  );
  await writeFile(jsonlPath, jsonlBytes);
  return { ...fixture, jsonlPath, jsonlBytes };
}

function provenanceEvent(options: {
  eventId: string;
  workflowId: string;
  source: string;
  eventName: "PostToolUse" | "PostToolUseFailure";
  toolName: string;
  detail: string;
  second: number;
}): RedactedProvenanceEvent {
  return {
    schemaVersion: 1,
    eventId: options.eventId,
    recordedAt: `2026-07-20T00:00:0${options.second}.000Z`,
    harness: "claude-code",
    eventName: options.eventName,
    sessionId,
    workflowId: options.workflowId,
    source: options.source,
    role: "agent",
    agentId: options.source,
    agentType: "builder",
    toolName: options.toolName,
    cwd: "<PROJECT_ROOT>",
    eventData:
      options.eventName === "PostToolUseFailure"
        ? { error: options.detail }
        : { tool_response: options.detail },
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: createHash("sha256").update(options.eventId).digest("hex"),
  };
}

function fixtureEvents(): RedactedProvenanceEvent[] {
  return [
    provenanceEvent({
      eventId: eventIds[0],
      workflowId: "workflow-alpha",
      source: "agent-a",
      eventName: "PostToolUseFailure",
      toolName: "Bash",
      detail: "shared timeout",
      second: 1,
    }),
    provenanceEvent({
      eventId: eventIds[1],
      workflowId: "workflow-alpha",
      source: "agent-b",
      eventName: "PostToolUse",
      toolName: "Edit",
      detail: "updated file",
      second: 2,
    }),
    provenanceEvent({
      eventId: eventIds[2],
      workflowId: "workflow-beta",
      source: "agent-a",
      eventName: "PostToolUseFailure",
      toolName: "Bash",
      detail: "shared timeout",
      second: 3,
    }),
  ];
}

async function invoke(
  root: string,
  argv: string[],
  recoveryServiceFactory?: ProvenanceLedgerRecoveryServiceFactory,
): Promise<CliResult> {
  const previousRoot = process.env.PROVENANCE_PROJECT_ROOT;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.env.PROVENANCE_PROJECT_ROOT = root;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runProvenanceCli(
      argv,
      Readable.from([]),
      recoveryServiceFactory,
    );
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    if (previousRoot === undefined) {
      delete process.env.PROVENANCE_PROJECT_ROOT;
    } else {
      process.env.PROVENANCE_PROJECT_ROOT = previousRoot;
    }
  }
}

function parseMachineJson<T>(result: CliResult): T {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as T;
  assert.equal(result.stdout, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

function parseMachineError(result: CliResult): CliErrorEnvelope {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  const parsed = JSON.parse(result.stderr) as CliErrorEnvelope;
  assert.equal(result.stderr, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.equal(parsed.schemaVersion, 1);
  return parsed;
}

async function findArchiveDirectory(ledgerPath: string): Promise<string> {
  const ledgerDirectory = dirname(ledgerPath);
  const prefix = `${basename(ledgerPath)}.archive-`;
  const archiveName = (await readdir(ledgerDirectory)).find((entry) =>
    entry.startsWith(prefix),
  );
  assert.ok(archiveName, "expected a recovery archive directory");
  return join(ledgerDirectory, archiveName);
}

test("filters and groups failures by workflow and agent", async (t) => {
  const { root } = await createFixture(t);
  const groups = parseMachineJson<
    Array<{
      agent: string;
      failureCount: number;
      toolCounts: Record<string, number>;
      failures: PersistedProvenanceEvent[];
    }>
  >(
    await invoke(root, [
      "failures",
      "--workflow",
      "workflow-alpha",
      "--agent",
      "agent-a",
      "--by-agent",
    ]),
  );

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups.map(({ agent, failureCount, toolCounts }) => ({
      agent,
      failureCount,
      toolCounts,
    })),
    [{ agent: "agent-a", failureCount: 1, toolCounts: { Bash: 1 } }],
  );
  assert.deepEqual(
    groups[0]?.failures.map((failure) => failure.eventId),
    [eventIds[0]],
  );
});

test("summarizes agents across workflow and actor filters", async (t) => {
  const { root } = await createFixture(t);
  const workflowSummary = parseMachineJson<
    Array<{ agent: string; eventCount: number; failureCount: number }>
  >(await invoke(root, ["agent-summary", "--workflow", "workflow-alpha"]));
  assert.deepEqual(workflowSummary, [
    {
      workflowId: "workflow-alpha",
      agent: "agent-a",
      agentId: "agent-a",
      agentType: "builder",
      eventCount: 1,
      failureCount: 1,
      toolNames: ["Bash"],
    },
    {
      workflowId: "workflow-alpha",
      agent: "agent-b",
      agentId: "agent-b",
      agentType: "builder",
      eventCount: 1,
      failureCount: 0,
      toolNames: ["Edit"],
    },
  ]);

  const actorSummary = parseMachineJson<
    Array<{ workflowId: string; agent: string; failureCount: number }>
  >(await invoke(root, ["agent-summary", "--agent", "agent-a"]));
  assert.deepEqual(
    actorSummary.map(({ workflowId, agent, failureCount }) => [
      workflowId,
      agent,
      failureCount,
    ]),
    [
      ["workflow-alpha", "agent-a", 1],
      ["workflow-beta", "agent-a", 1],
    ],
  );
});

test("exports sessions and events as JSON and JSONL", async (t) => {
  const { root } = await createFixture(t);
  const sessions = parseMachineJson<Array<{ workflowId: string }>>(
    await invoke(root, ["sessions", "--session-id", sessionId]),
  );
  assert.deepEqual(
    sessions.map(({ workflowId }) => workflowId),
    ["workflow-alpha", "workflow-beta"],
  );

  const events = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["events", "--workflow", "workflow-alpha"]),
  );
  assert.deepEqual(
    events.map((event) => event.eventId),
    [eventIds[0], eventIds[1]],
  );

  const jsonEvents = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["export", sessionId, "--format", "json"]),
  );
  assert.deepEqual(
    jsonEvents.map((event) => event.sequence),
    [1, 2, 3],
  );

  const jsonl = await invoke(root, ["export", sessionId, "--format", "jsonl"]);
  assert.equal(jsonl.code, 0, jsonl.stderr);
  assert.equal(jsonl.stderr, "");
  assert.ok(jsonl.stdout.endsWith("\n"));
  const jsonlEvents = jsonl.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as PersistedProvenanceEvent);
  assert.deepEqual(
    jsonlEvents.map((event) => event.sequence),
    [1, 2, 3],
  );
});

test("falls back to grouped failures when patterns lacks vectors", async (t) => {
  const { root } = await createFixture(t);
  const result = parseMachineJson<{
    usedStructuredFallback: boolean;
    matches: Array<{
      failure: PersistedProvenanceEvent;
      relatedFailure: PersistedProvenanceEvent;
      score: number;
    }>;
  }>(await invoke(root, ["patterns", "--workflow", "workflow-alpha"]));

  assert.equal(result.usedStructuredFallback, true);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(
    result.matches.map(({ failure, relatedFailure, score }) => [
      failure.eventId,
      relatedFailure.eventId,
      score,
    ]),
    [[eventIds[0], eventIds[2], 1]],
  );
});

test("registers nine existing commands plus ledger-status and recover-ledger", async (t) => {
  const { root, config } = await createFixture(t);
  const source = await readFile(
    join(provenanceRoot, "provenance-cli.ts"),
    "utf8",
  );
  const registeredCommands = [...source.matchAll(/\.command\("([a-z-]+)"\)/gu)]
    .map((match) => match[1])
    .filter((command): command is string => command !== undefined)
    .sort();
  assert.equal(CLI_COMMANDS.length, 11);
  assert.deepEqual(registeredCommands, [...CLI_COMMANDS]);

  const ledgerPath = join(root, config.paths.ledger);
  const before = await readFile(ledgerPath);
  parseMachineJson(await invoke(root, ["events", "--limit", "1"]));
  parseMachineJson(
    await invoke(root, ["patterns", "--workflow", "workflow-alpha"]),
  );
  assert.deepEqual(await readFile(ledgerPath), before);
  assert.equal(
    existsSync(join(root, config.paths.modelCacheDirectory)),
    false,
    "passive commands must not initialize the local model cache",
  );
});

test("reports legacy schema through ledger-status without mutation", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const before = await readFile(ledgerPath);

  const inspection = parseMachineJson<ProvenanceLedgerSchemaInspection>(
    await invoke(root, ["ledger-status"]),
  );

  assert.equal(inspection.state, "incompatible");
  assert.match(inspection.databasePath, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(JSON.stringify(inspection).includes(root), false);
  assert.equal(inspection.observedUserVersion, 0);
  assert.ok(inspection.reasonCodes.includes("required-column-missing"));
  assert.deepEqual(await readFile(ledgerPath), before);
  assert.equal(existsSync(`${ledgerPath}-wal`), false);
  assert.equal(existsSync(`${ledgerPath}-shm`), false);
  assert.equal(existsSync(join(root, config.paths.modelCacheDirectory)), false);
});

test("defaults recover-ledger to a machine-readable dry run", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const jsonlPath = join(
    root,
    config.paths.jsonlDirectory,
    "claude-code",
    `${sessionId}.jsonl`,
  );
  const beforeLedger = await readFile(ledgerPath);
  const beforeJsonl = await readFile(jsonlPath);

  const result = parseMachineJson<ProvenanceLedgerRecoveryResult>(
    await invoke(root, ["recover-ledger"]),
  );

  assert.equal(result.mode, "dry-run");
  assert.equal(result.status, "would-rebuild");
  assert.match(result.before.databasePath, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(result.replayedEventCount, fixtureEvents().length);
  assert.equal(result.archive, undefined);
  assert.equal(result.semanticReindexRequired, true);
  assert.deepEqual(await readFile(ledgerPath), beforeLedger);
  assert.deepEqual(await readFile(jsonlPath), beforeJsonl);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
});

test("requires --apply and reports archive and semantic reindex state", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const legacyBytes = await readFile(ledgerPath);

  const result = parseMachineJson<ProvenanceLedgerRecoveryResult>(
    await invoke(root, ["recover-ledger", "--apply"]),
  );

  assert.equal(result.mode, "apply");
  assert.equal(result.status, "rebuilt");
  assert.equal(result.after?.state, "current");
  assert.equal(result.semanticReindexRequired, true);
  assert.equal(result.replayedEventCount, fixtureEvents().length);
  assert.ok(result.archive);
  assert.match(result.archive.directory, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(JSON.stringify(result).includes(root), false);
  const archiveDirectory = await findArchiveDirectory(ledgerPath);
  assert.deepEqual(
    await readFile(join(archiveDirectory, basename(ledgerPath))),
    legacyBytes,
  );
  assert.equal(existsSync(archiveDirectory), true);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(root, config.paths.modelCacheDirectory)), false);
});

test("returns a typed bounded envelope for a raw replacement failure", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const legacyBytes = await readFile(ledgerPath);
  const rawFailure = `RAW_SWAP_FAILURE ${root} token=NOT_FOR_OPERATORS`;

  const invocation = await invoke(
    root,
    ["recover-ledger", "--apply"],
    (repositoryRoot, recoveryConfig) =>
      new ProvenanceLedgerRecoveryService(
        join(repositoryRoot, recoveryConfig.paths.ledger),
        join(repositoryRoot, recoveryConfig.paths.jsonlDirectory),
        undefined,
        undefined,
        () => {
          throw new Error(rawFailure);
        },
      ),
  );
  const envelope = parseMachineError(invocation);
  assert.equal(
    envelope.error.code,
    "PROVENANCE_LEDGER_RECOVERY_OPERATION_FAILED",
  );
  assert.equal(envelope.error.cause, "replacement");
  assert.equal(envelope.error.nextAction.code, "inspect-retry-recovery");
  assert.equal(envelope.error.nextAction.command, "ledger-status");
  assert.deepEqual(envelope.error.details.stage, "replacement");
  const evidence = envelope.error.details.evidence as Record<string, unknown>;
  assert.match(
    String(evidence.archiveToken),
    /^<ledger-adjacent>\/provenance\.db\.archive-/u,
  );
  assert.match(
    String(evidence.replacementToken),
    /^<ledger-adjacent>\/\.provenance\.db\..+\.rebuild$/u,
  );
  assert.equal(invocation.stderr.includes(root), false);
  assert.equal(invocation.stderr.includes(rawFailure), false);
  assert.equal(invocation.stderr.includes("NOT_FOR_OPERATORS"), false);
  assert.ok(Buffer.byteLength(invocation.stderr, "utf8") <= 2_000);
  assert.deepEqual(await readFile(ledgerPath), legacyBytes);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
});

test("returns PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED with safe archive evidence", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const rawCleanupFailure = `RAW_CLEANUP_FAILURE ${root} secret=NESTED_CAUSE`;

  const invocation = await invoke(
    root,
    ["recover-ledger", "--apply"],
    (repositoryRoot, recoveryConfig) =>
      new ProvenanceLedgerRecoveryService(
        join(repositoryRoot, recoveryConfig.paths.ledger),
        join(repositoryRoot, recoveryConfig.paths.jsonlDirectory),
        undefined,
        undefined,
        undefined,
        {
          removeTemporaryArtifact: () => {
            throw new Error(rawCleanupFailure);
          },
        },
      ),
  );
  const envelope = parseMachineError(invocation);
  assert.equal(
    envelope.error.code,
    "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED",
  );
  assert.equal(envelope.error.cause, "cleanup");
  assert.equal(envelope.error.nextAction.code, "inspect-retry-recovery");
  assert.equal(envelope.error.nextAction.command, "ledger-status");
  assert.deepEqual(envelope.error.details.stage, "cleanup");
  const evidence = envelope.error.details.evidence as Record<string, unknown>;
  assert.match(
    String(evidence.archiveToken),
    /^<ledger-adjacent>\/provenance\.db\.archive-/u,
  );
  assert.match(
    String(evidence.replacementToken),
    /^<ledger-adjacent>\/\.provenance\.db\..+\.rebuild$/u,
  );
  assert.equal(invocation.stderr.includes(root), false);
  assert.equal(invocation.stderr.includes(rawCleanupFailure), false);
  assert.equal(invocation.stderr.includes("NESTED_CAUSE"), false);
  assert.ok(Buffer.byteLength(invocation.stderr, "utf8") <= 2_000);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock.interrupted`), true);
});

test("rejects trusted-looking raw archive text during combined cleanup failure", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const rawPrimaryFailure =
    `preserved archive: <ledger-adjacent>/RAW_UPSTREAM_SENTINEL ${root}`;
  const rawCleanupFailure = "RAW_NESTED_CLEANUP_CAUSE";

  const invocation = await invoke(
    root,
    ["recover-ledger", "--apply"],
    (repositoryRoot, recoveryConfig) =>
      new ProvenanceLedgerRecoveryService(
        join(repositoryRoot, recoveryConfig.paths.ledger),
        join(repositoryRoot, recoveryConfig.paths.jsonlDirectory),
        undefined,
        undefined,
        () => {
          throw new Error(rawPrimaryFailure);
        },
        {
          removeTemporaryArtifact: () => {
            throw new Error(rawCleanupFailure);
          },
        },
      ),
  );
  const envelope = parseMachineError(invocation);
  assert.equal(
    envelope.error.code,
    "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED",
  );
  assert.equal(envelope.error.cause, "cleanup");
  assert.equal(envelope.error.nextAction.code, "inspect-retry-recovery");
  assert.deepEqual(envelope.error.details.stage, "cleanup");
  const evidence = envelope.error.details.evidence as Record<string, unknown>;
  assert.match(
    String(evidence.archiveToken),
    /^<ledger-adjacent>\/provenance\.db\.archive-/u,
  );
  assert.match(
    String(evidence.replacementToken),
    /^<ledger-adjacent>\/\.provenance\.db\..+\.rebuild$/u,
  );
  assert.equal(JSON.stringify(evidence).includes("RAW_UPSTREAM_SENTINEL"), false);
  assert.equal(invocation.stderr.includes("RAW_UPSTREAM_SENTINEL"), false);
  assert.equal(invocation.stderr.includes(rawCleanupFailure), false);
  assert.equal(invocation.stderr.includes(root), false);
  assert.ok(Buffer.byteLength(invocation.stderr, "utf8") <= 2_000);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock.interrupted`), true);
});

test("runs existing sessions events export and failures after recovery", async (t) => {
  const { root } = await createLegacyRecoveryFixture(t);
  parseMachineJson<ProvenanceLedgerRecoveryResult>(
    await invoke(root, ["recover-ledger", "--apply"]),
  );

  const sessions = parseMachineJson<Array<{ workflowId?: string }>>(
    await invoke(root, ["sessions", "--session-id", sessionId]),
  );
  assert.deepEqual(
    sessions.map((entry) => entry.workflowId),
    ["workflow-alpha", "workflow-beta"],
  );

  const events = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["events", "--workflow", "workflow-alpha"]),
  );
  assert.deepEqual(
    events.map((event) => event.eventId),
    [eventIds[0], eventIds[1]],
  );

  const exported = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["export", sessionId, "--format", "json"]),
  );
  assert.deepEqual(
    exported.map((event) => event.eventId),
    [...eventIds],
  );

  const failures = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["failures", "--agent", "agent-a"]),
  );
  assert.deepEqual(
    failures.map((event) => event.eventId),
    [eventIds[0], eventIds[2]],
  );
});

test("partially recovers the observed corpus with safe diagnostics and queryable exports", async (t) => {
  const { root, config, jsonlBytes } = await createObservedPartialRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const legacyBytes = await readFile(ledgerPath);

  const invocation = await invoke(root, ["recover-ledger", "--apply"]);
  const result = parseMachineJson<ProvenanceLedgerRecoveryResult>(invocation);
  assert.equal(result.status, "rebuilt");
  assert.equal(result.replayedEventCount, 138);
  assert.equal(result.replay.jsonlFileCount, 7);
  assert.equal(result.replay.nonBlankLineCount, 315);
  assert.equal(result.replay.validEventCount, 138);
  assert.equal(result.replay.invalidRecordCount, 177);
  assert.equal(result.replay.conflictingEventCount, 0);
  assert.equal(result.replay.disposition, "partial");
  assert.equal(result.replay.skippedIssueCount, 177);
  assert.equal(result.replay.blockingIssueCount, 0);
  assert.equal(result.replay.issuesShown, 100);
  assert.equal(result.replay.issuesTruncated, true);
  assert.equal(result.nextAction.code, "review-skipped-replay-evidence");
  assert.equal("command" in result.nextAction, false);
  assert.equal(
    result.nextAction.message,
    "Structured recovery completed with invalid replay records excluded and preserved; review the listed relative evidence before running semantic indexing explicitly.",
  );
  assert.equal(result.semanticReindexRequired, true);
  assert.ok(result.archive);
  assert.match(result.archive.directory, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(invocation.stdout.includes(root), false);
  assert.ok(Buffer.byteLength(invocation.stdout, "utf8") <= 100_000);
  for (const issue of result.replay.issues) {
    assert.match(issue.relativePath, /^(?:codex|claude)[\\/]observed-[1-7]\.jsonl$/u);
    assert.equal(issue.disposition, "skipped");
    assert.equal(issue.relativePath.includes(root), false);
  }
  for (const [jsonlPath, beforeBytes] of jsonlBytes) {
    assert.deepEqual(await readFile(jsonlPath), beforeBytes);
  }
  const archiveDirectory = await findArchiveDirectory(ledgerPath);
  assert.deepEqual(
    await readFile(join(archiveDirectory, basename(ledgerPath))),
    legacyBytes,
  );

  const sessions = parseMachineJson<Array<{ workflowId?: string }>>(
    await invoke(root, ["sessions", "--session-id", sessionId, "--limit", "200"]),
  );
  assert.deepEqual(sessions.map((entry) => entry.workflowId), ["workflow-observed"]);
  const events = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["events", "--workflow", "workflow-observed", "--limit", "200"]),
  );
  assert.equal(events.length, 138);
  const exported = parseMachineJson<PersistedProvenanceEvent[]>(
    await invoke(root, ["export", sessionId, "--format", "json"]),
  );
  assert.equal(exported.length, 138);

  const recovered = new Database(ledgerPath, { readonly: true });
  try {
    assert.equal(
      recovered.prepare("SELECT COUNT(*) FROM provenance_events WHERE vectorized = 0").pluck().get(),
      138,
    );
  } finally {
    recovered.close();
  }
  assert.equal(existsSync(join(root, config.paths.modelCacheDirectory)), false);
});

test("reports correct-replay-evidence with a retained beyond-limit conflict location", async (t) => {
  const { root, config, jsonlPath, jsonlBytes } =
    await createBeyondLimitConflictRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  const legacyBytes = await readFile(ledgerPath);

  const invocation = await invoke(root, ["recover-ledger", "--apply"]);
  const envelope = parseMachineError(invocation);
  assert.equal(envelope.error.code, "PROVENANCE_LEDGER_RECOVERY_BLOCKED");
  assert.equal(envelope.error.cause, "pre-mutation-replay");
  assert.equal(envelope.error.nextAction.code, "correct-replay-evidence");
  assert.equal(envelope.error.nextAction.command, "recover-ledger");

  const details = envelope.error.details as unknown as ProvenanceLedgerRecoveryResult;
  assert.equal(details.status, "blocked");
  assert.equal(details.replay.invalidRecordCount, 100);
  assert.equal(details.replay.conflictingEventCount, 1);
  assert.equal(details.replay.skippedIssueCount, 100);
  assert.equal(details.replay.blockingIssueCount, 1);
  assert.equal(details.replay.issuesShown, 100);
  assert.equal(details.replay.issuesTruncated, true);
  assert.deepEqual(
    details.replay.issues.filter(
      (issue) => issue.code === "conflicting-event-id",
    ),
    [
      {
        relativePath: "codex/beyond-limit-conflict.jsonl",
        lineNumber: 102,
        disposition: "blocking",
        code: "conflicting-event-id",
        sanitizedMessage:
          "The event ID is reused by a different redacted provenance event.",
      },
    ],
  );
  assert.equal(invocation.stderr.includes(root), false);
  assert.equal(invocation.stderr.includes("CLI_RAW_RECORD"), false);
  assert.deepEqual(await readFile(ledgerPath), legacyBytes);
  assert.deepEqual(await readFile(jsonlPath), jsonlBytes);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
});

test("distinguishes active recovery marker contention", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  await writeFile(
    `${ledgerPath}.recovery.lock`,
    JSON.stringify({ pid: 999_999, acquiredAt: "2026-07-20T00:00:00.000Z" }),
    "utf8",
  );

  const envelope = parseMachineError(
    await invoke(root, ["recover-ledger", "--apply"]),
  );
  assert.equal(envelope.error.code, "PROVENANCE_LEDGER_RECOVERY_BLOCKED");
  assert.equal(envelope.error.cause, "active-recovery-marker");
  assert.equal(envelope.error.nextAction.code, "wait-inspect-retry");
  assert.equal(envelope.error.nextAction.command, "ledger-status");
  const details = envelope.error.details as unknown as ProvenanceLedgerRecoveryResult;
  assert.equal(details.before.recoveryMarkerPresent, true);
  assert.equal(details.recoveryMarkerCleared, false);
  assert.equal(JSON.stringify(envelope).includes(root), false);
});

test("resumes post-swap recovery when replay evidence is partial", async (t) => {
  const { root, config } = await createLegacyRecoveryFixture(t);
  const ledgerPath = join(root, config.paths.ledger);
  parseMachineJson<ProvenanceLedgerRecoveryResult>(
    await invoke(root, ["recover-ledger", "--apply"]),
  );
  const archiveDirectory = await findArchiveDirectory(ledgerPath);
  const jsonlPath = join(
    root,
    config.paths.jsonlDirectory,
    "claude-code",
    `${sessionId}.jsonl`,
  );
  await writeFile(
    `${ledgerPath}.recovery.lock.interrupted`,
    JSON.stringify({
      schemaVersion: 1,
      originalState: "incompatible",
      replayedEventCount: fixtureEvents().length,
      archive: {
        directory: archiveDirectory,
        databaseFile: join(archiveDirectory, basename(ledgerPath)),
      },
    }),
    "utf8",
  );
  await writeFile(
    jsonlPath,
    `${await readFile(jsonlPath, "utf8")}{not-valid-json\n`,
    "utf8",
  );

  const result = parseMachineJson<ProvenanceLedgerRecoveryResult>(
    await invoke(root, ["recover-ledger", "--apply"]),
  );
  assert.equal(result.status, "rebuilt");
  assert.equal(result.after?.state, "current");
  assert.equal(result.replayedEventCount, fixtureEvents().length);
  assert.equal(result.replay.disposition, "partial");
  assert.equal(result.replay.invalidRecordCount, 1);
  assert.equal(result.nextAction.code, "review-skipped-replay-evidence");
  assert.match(result.archive?.directory ?? "", /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(existsSync(archiveDirectory), true);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("emits typed schema drift details and recovery guidance", async (t) => {
  const { root } = await createLegacyRecoveryFixture(t);
  const envelope = parseMachineError(
    await invoke(root, ["ledger-status", "--require-ready"]),
  );
  assert.equal(envelope.error.code, "PROVENANCE_LEDGER_SCHEMA_DRIFT");
  assert.equal(envelope.error.cause, "schema-drift");
  assert.equal(envelope.error.nextAction.code, "preview-recovery");
  assert.equal(envelope.error.nextAction.command, "recover-ledger");
  const details = envelope.error.details as unknown as ProvenanceLedgerSchemaInspection;
  assert.equal(details.state, "incompatible");
  assert.ok(details.reasonCodes.includes("required-column-missing"));
  assert.match(details.databasePath, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(JSON.stringify(envelope).includes(root), false);
});

test("projects Windows and POSIX structured paths without payloads or secrets", () => {
  const windowsRoot = "D:\\Work\\Propel-ADW";
  const secret = "sk-ant-SYNTHETICSECRET1234567890";
  const windowsProjection = projectProvenanceStructuredOutput(
    {
      databasePath: `${windowsRoot}\\.agents\\data\\provenance.db`,
      wslPath: "/mnt/d/Work/Propel-ADW/.agents/data/provenance.db",
      homePath: join(homedir(), "private", "ledger.db"),
      tempPath: join(tmpdir(), "provenance", "ledger.db"),
      message: `failed ${secret}`,
      payload: { secret },
      values: Array.from({ length: 150 }, (_, index) => index),
    },
    { projectRoot: windowsRoot },
  ) as Record<string, unknown>;
  const windowsSerialized = JSON.stringify(windowsProjection);
  assert.ok(windowsSerialized.includes(PROJECT_ROOT));
  assert.ok(windowsSerialized.includes(USER_HOME));
  assert.ok(windowsSerialized.includes(TEMP_DIR));
  assert.equal(windowsSerialized.includes(windowsRoot), false);
  assert.equal(windowsSerialized.includes("/mnt/d/Work/Propel-ADW"), false);
  assert.equal(windowsSerialized.includes(secret), false);
  assert.equal("payload" in windowsProjection, false);
  assert.equal((windowsProjection.values as unknown[]).length, 100);

  const posixRoot = "/srv/propel-adw";
  const posixSerialized = JSON.stringify(
    projectProvenanceStructuredOutput(
      { archive: `${posixRoot}/.agents/data/archive/provenance.db` },
      { projectRoot: posixRoot },
    ),
  );
  assert.ok(posixSerialized.includes(PROJECT_ROOT));
  assert.equal(posixSerialized.includes(posixRoot), false);
});

test("malformed arguments emit one bounded secret and path safe diagnostic", async (t) => {
  const { root } = await createFixture(t);
  const syntheticValues = [
    "github_pat_SYNTHETICSECRET1234567890",
    "sk-ant-SYNTHETICSECRET1234567890",
    "AKIASYNTHETIC123456789",
    "rk_live_SYNTHETICSECRET123456",
    "eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.c2lnbmF0dXJl",
    "postgresql://synthetic-user:synthetic-password@example.invalid/database",
    "Bearer SYNTHETICAUTHORIZATION123456",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETICPRIVATEKEY\n-----END PRIVATE KEY-----",
    `${root}\nclient_secret=SYNTHETICCLIENTSECRET`,
    `token=${"A".repeat(5_000)}`,
  ];

  for (const secret of syntheticValues) {
    const result = await invoke(root, ["events", `--bogus=${secret}`]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.match(/Provenance CLI error/gu)?.length,
      1,
      result.stderr,
    );
    assert.equal(result.stderr.includes(secret), false, result.stderr);
    assert.equal(result.stderr.includes(root), false, result.stderr);
    assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1_200, result.stderr);
  }
});
