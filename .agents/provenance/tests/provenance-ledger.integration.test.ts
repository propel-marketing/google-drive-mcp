import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import { captureProvenanceEvent } from "../capture-provenance-event.js";
import {
  PROVENANCE_LEDGER_USER_VERSION,
  ProvenanceLedgerSchemaDriftError,
  ProvenanceLedgerSchemaInspector,
  provenanceLedgerRecoveryMarkerPath,
} from "../provenance-ledger-definition.js";
import type {
  ProvenanceCaptureConfig,
  RedactedProvenanceEvent,
} from "../provenance-schemas.js";
import { ProvenanceLedgerWriter } from "../write-provenance-ledger.js";

const DEFAULT_LEDGER = ".agents/data/provenance/provenance.db";
const DEFAULT_JSONL = ".agents/data/provenance/jsonl";

async function temporaryProject(
  t: TestContext,
  name: string,
  paths: Partial<ProvenanceCaptureConfig["paths"]> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `provenance-mvp-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "provenance"), { recursive: true });
  const config: ProvenanceCaptureConfig = {
    schemaVersion: 1,
    enabled: true,
    neverControlsWorkflow: true,
    maxFieldBytes: 65_536,
    paths: {
      ledger: DEFAULT_LEDGER,
      jsonlDirectory: DEFAULT_JSONL,
      actorStateDirectory: ".agents/data/provenance/actors",
      modelCacheDirectory: ".agents/data/provenance/models",
      ...paths,
    },
    jsonl: {
      lockRetryCount: 0,
      lockRetryDelayMs: 0,
      staleLockMs: 30_000,
    },
    embeddings: {
      modelId: "test/local-model",
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
  };
  await writeFile(
    join(root, ".agents", "provenance", "provenance.config.json"),
    JSON.stringify(config),
    "utf8",
  );
  return root;
}

async function capture(root: string, sessionId: string, marker: string) {
  const previousRoot = process.env.PROVENANCE_PROJECT_ROOT;
  process.env.PROVENANCE_PROJECT_ROOT = root;
  try {
    return await captureProvenanceEvent("codex", {
      session_id: sessionId,
      cwd: root,
      hook_event_name: "PostToolUse",
      source: "main",
      tool_name: "exec_command",
      tool_input: { cmd: `echo ${marker}` },
      tool_response: marker,
    });
  } finally {
    if (previousRoot === undefined) delete process.env.PROVENANCE_PROJECT_ROOT;
    else process.env.PROVENANCE_PROJECT_ROOT = previousRoot;
  }
}

function sessionJsonlPath(root: string, sessionId: string): string {
  const token = createHash("sha256").update(sessionId).digest("hex");
  return join(root, DEFAULT_JSONL, "codex", `session-${token}.jsonl`);
}

async function jsonlEvents(path: string): Promise<Array<{ eventId: string }>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { eventId: string });
}

function assertSafeDegradedDiagnostic(
  root: string,
  result: Awaited<ReturnType<typeof capture>>,
  forbiddenValues: string[],
): void {
  assert.equal(result.status, "degraded");
  assert.equal(result.receipt, undefined);
  assert.equal(result.diagnostics.length, 1);
  const output = JSON.stringify(result.diagnostics[0]);
  assert.ok(output.length <= 2_048);
  assert.equal(output.includes(root), false);
  for (const forbiddenValue of forbiddenValues) {
    assert.equal(output.includes(forbiddenValue), false);
  }
}

function replayEvent(
  overrides: Partial<RedactedProvenanceEvent> = {},
): RedactedProvenanceEvent {
  return {
    schemaVersion: 1,
    eventId: "11111111-1111-4111-8111-111111111111",
    recordedAt: "2026-07-20T12:00:00.000Z",
    harness: "codex",
    eventName: "PostToolUse",
    sessionId: "replay-session",
    source: "main",
    role: "agent",
    toolName: "exec_command",
    cwd: ".",
    eventData: { status: "complete" },
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: "a".repeat(64),
    ...overrides,
  };
}

function createLegacyFourTableLedger(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE provenance_sessions (
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        initial_cwd TEXT NOT NULL,
        final_cwd TEXT NOT NULL,
        source TEXT,
        integrity_status TEXT NOT NULL CHECK (
          integrity_status IN ('complete', 'recoverable', 'incomplete')
        ),
        PRIMARY KEY (harness, session_id)
      );
      CREATE TABLE provenance_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        delivery_key TEXT,
        source_fingerprint TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        source_timestamp TEXT,
        harness TEXT NOT NULL,
        event_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        agent_id TEXT,
        agent_type TEXT,
        plan_name TEXT,
        task_id TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        outcome TEXT NOT NULL,
        cwd_tokenized TEXT NOT NULL,
        transcript_path_tokenized TEXT,
        sanitized_payload_json TEXT NOT NULL,
        redaction_count INTEGER NOT NULL,
        truncated_fields_json TEXT NOT NULL,
        sanitized_payload_sha256 TEXT NOT NULL,
        jsonl_state TEXT NOT NULL CHECK (jsonl_state IN ('pending', 'written')),
        embedding_state TEXT NOT NULL CHECK (
          embedding_state IN ('excluded', 'pending', 'written', 'failed')
        ),
        FOREIGN KEY (harness, session_id)
          REFERENCES provenance_sessions(harness, session_id)
      );
      CREATE UNIQUE INDEX provenance_events_delivery_key_unique
        ON provenance_events(delivery_key) WHERE delivery_key IS NOT NULL;
      CREATE INDEX provenance_events_session_sequence
        ON provenance_events(harness, session_id, sequence);
      CREATE INDEX provenance_events_jsonl_state
        ON provenance_events(jsonl_state, sequence);
      CREATE TABLE provenance_embeddings (
        event_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        content_sha256 TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES provenance_events(event_id)
      );
      CREATE TABLE provenance_integrity_issues (
        issue_id TEXT PRIMARY KEY,
        harness TEXT,
        session_id TEXT,
        event_id TEXT,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        resolved_at TEXT
      );
      PRAGMA user_version = 0;
    `);
  } finally {
    database.close();
  }
}

test("writes JSONL before opening SQLite", async (t) => {
  const sharedStore = ".agents/data/provenance/shared";
  const root = await temporaryProject(t, "jsonl-first", {
    ledger: sharedStore,
    jsonlDirectory: sharedStore,
  });

  const result = await capture(root, "jsonl-first-session", "first");

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.diagnostics.map(({ stage }) => stage), ["sqlite"]);
  const records = await jsonlEvents(
    join(
      root,
      sharedStore,
      "codex",
      `session-${createHash("sha256").update("jsonl-first-session").digest("hex")}.jsonl`,
    ),
  );
  assert.deepEqual(records.map(({ eventId }) => eventId), [result.eventId]);
});

test("creates and stamps the current ledger schema", async (t) => {
  const root = await temporaryProject(t, "schema");
  const databasePath = join(root, DEFAULT_LEDGER);
  new ProvenanceLedgerWriter(databasePath).close();

  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all();
    assert.deepEqual(tables, ["provenance_embeddings", "provenance_events"]);

    const indexes = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'provenance_events_%' ORDER BY name",
      )
      .pluck()
      .all();
    assert.deepEqual(indexes, [
      "provenance_events_actor_sequence",
      "provenance_events_event_sequence",
      "provenance_events_recorded_at",
      "provenance_events_session_sequence",
      "provenance_events_vectorized",
      "provenance_events_workflow_sequence",
    ]);
    assert.equal(
      database.pragma("user_version", { simple: true }),
      PROVENANCE_LEDGER_USER_VERSION,
    );
    assert.equal(
      new ProvenanceLedgerSchemaInspector().inspect(databasePath).state,
      "current",
    );
  } finally {
    database.close();
  }
});

test("rejects the legacy schema before preparing current insert SQL", async (t) => {
  const root = await temporaryProject(t, "legacy-pre-sql-rejection");
  const databasePath = join(root, DEFAULT_LEDGER);
  await mkdir(join(root, DEFAULT_JSONL), { recursive: true });
  createLegacyFourTableLedger(databasePath);
  const beforeBytes = await readFile(databasePath);

  assert.throws(
    () => new ProvenanceLedgerWriter(databasePath),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerSchemaDriftError, true);
      assert.equal(
        (error as ProvenanceLedgerSchemaDriftError).code,
        "PROVENANCE_LEDGER_SCHEMA_DRIFT",
      );
      assert.equal(
        (error as ProvenanceLedgerSchemaDriftError).inspection.state,
        "incompatible",
      );
      assert.equal(
        (error as ProvenanceLedgerSchemaDriftError).inspection.reasonCodes.includes(
          "required-column-missing",
        ),
        true,
      );
      return true;
    },
  );

  assert.deepEqual(await readFile(databasePath), beforeBytes);
  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
});

test("keeps JSONL and returns actionable degraded capture on schema drift", async (t) => {
  const root = await temporaryProject(t, "legacy-capture-degradation");
  const databasePath = join(root, DEFAULT_LEDGER);
  createLegacyFourTableLedger(databasePath);
  const beforeBytes = await readFile(databasePath);

  const result = await capture(
    root,
    "legacy-drift-session",
    "retained-on-drift raw-validation-input password=drift-secret",
  );

  assertSafeDegradedDiagnostic(root, result, [
    "retained-on-drift",
    "password=drift-secret",
    "raw-validation-input",
  ]);
  assert.deepEqual(result.diagnostics[0], {
    stage: "sqlite",
    errorName: "ProvenanceLedgerSchemaDriftError",
    errorCode: "PROVENANCE_LEDGER_SCHEMA_DRIFT",
    sanitizedMessage:
      "The provenance ledger is not ready for current queries. Run node scripts/init.mjs to inspect and recover it. Safe next step: Run node scripts/init.mjs --check to diagnose the provenance ledger, then run node scripts/init.mjs for explicit recovery; workflow execution can continue.",
    remediation:
      "Run node scripts/init.mjs --check to diagnose the provenance ledger, then run node scripts/init.mjs for explicit recovery; workflow execution can continue.",
  });
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "legacy-drift-session"))).map(
      ({ eventId }) => eventId,
    ),
    [result.eventId],
  );
  assert.deepEqual(await readFile(databasePath), beforeBytes);
  assert.equal(existsSync(`${databasePath}-wal`), false);
});

test("keeps JSONL and advises wait inspect retry during recovery marker contention", async (t) => {
  const root = await temporaryProject(t, "marker-capture-degradation");
  const databasePath = join(root, DEFAULT_LEDGER);
  new ProvenanceLedgerWriter(databasePath).close();
  const markerPath = provenanceLedgerRecoveryMarkerPath(databasePath);
  await writeFile(markerPath, JSON.stringify({ pid: 12345 }), "utf8");

  const result = await capture(
    root,
    "marker-contention-session",
    "marker-payload-secret raw-validation-input password=marker-secret",
  );

  assertSafeDegradedDiagnostic(root, result, [
    "marker-payload-secret",
    "password=marker-secret",
    "raw-validation-input",
  ]);
  assert.equal(result.diagnostics[0]?.errorCode, "PROVENANCE_LEDGER_SCHEMA_DRIFT");
  assert.equal(
    result.diagnostics[0]?.remediation,
    "Wait for the active provenance recovery to finish, inspect with node scripts/init.mjs --check, then retry capture while leaving the recovery marker untouched; workflow execution can continue.",
  );
  assert.match(result.diagnostics[0]?.sanitizedMessage ?? "", /wait for the active provenance recovery/iu);
  assert.doesNotMatch(result.diagnostics[0]?.sanitizedMessage ?? "", /delete|remove/iu);
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "marker-contention-session"))).map(
      ({ eventId }) => eventId,
    ),
    [result.eventId],
  );
  assert.equal(existsSync(markerPath), true);
});

test("keeps JSONL and reserves path permission advice for SQLite I/O failure", async (t) => {
  const blockedLedgerParent = ".agents/data/provenance/sqlite-parent-file";
  const root = await temporaryProject(t, "sqlite-io-capture-degradation", {
    ledger: `${blockedLedgerParent}/provenance.db`,
  });
  const blockedParentPath = join(root, blockedLedgerParent);
  await mkdir(dirname(blockedParentPath), { recursive: true });
  await writeFile(blockedParentPath, "not-a-directory", "utf8");

  const result = await capture(
    root,
    "sqlite-io-session",
    "io-payload-secret raw-validation-input password=io-secret",
  );

  assertSafeDegradedDiagnostic(root, result, [
    "io-payload-secret",
    "password=io-secret",
    "raw-validation-input",
  ]);
  assert.equal(
    result.diagnostics[0]?.remediation,
    "Check the configured local SQLite path and permissions; workflow execution can continue.",
  );
  assert.notEqual(result.diagnostics[0]?.errorCode, "PROVENANCE_LEDGER_SCHEMA_DRIFT");
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "sqlite-io-session"))).map(
      ({ eventId }) => eventId,
    ),
    [result.eventId],
  );
});

test("insertIfAbsent inserts a replay event on first use", async (t) => {
  const root = await temporaryProject(t, "replay-first-insert");
  const databasePath = join(root, DEFAULT_LEDGER);
  const writer = new ProvenanceLedgerWriter(databasePath);
  const event = replayEvent();

  try {
    const result = writer.insertIfAbsent(event);

    assert.equal(result.inserted, true);
    assert.deepEqual(result.receipt, {
      sequence: 1,
      eventId: event.eventId,
      sessionId: event.sessionId,
    });
  } finally {
    writer.close();
  }

  const database = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      database.prepare("SELECT COUNT(*) FROM provenance_events").pluck().get(),
      1,
    );
  } finally {
    database.close();
  }
});

test("insertIfAbsent leaves an identical replay event unchanged", async (t) => {
  const root = await temporaryProject(t, "replay-identical-duplicate");
  const databasePath = join(root, DEFAULT_LEDGER);
  const writer = new ProvenanceLedgerWriter(databasePath);
  const event = replayEvent();

  try {
    writer.insertIfAbsent(event);
    writer.markEmbeddingWritten(event.eventId);

    assert.deepEqual(writer.insertIfAbsent(event), { inserted: false });
  } finally {
    writer.close();
  }

  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database
      .prepare(
        `SELECT sequence, redacted_event_json AS redactedEventJson, vectorized
         FROM provenance_events WHERE event_id = ?`,
      )
      .all(event.eventId) as Array<{
        sequence: number;
        redactedEventJson: string;
        vectorized: number;
      }>;
    assert.deepEqual(rows, [{
      sequence: 1,
      redactedEventJson: JSON.stringify(event),
      vectorized: 1,
    }]);
  } finally {
    database.close();
  }
});

test("insertIfAbsent rejects conflicting reuse of an eventId", async (t) => {
  const root = await temporaryProject(t, "replay-event-id-conflict");
  const databasePath = join(root, DEFAULT_LEDGER);
  const writer = new ProvenanceLedgerWriter(databasePath);
  const event = replayEvent();

  try {
    writer.insertIfAbsent(event);

    assert.throws(
      () => writer.insertIfAbsent({
        ...event,
        eventData: { status: "different" },
        contentSha256: "b".repeat(64),
      }),
      /Conflicting provenance eventId reuse/u,
    );
  } finally {
    writer.close();
  }

  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database
      .prepare(
        "SELECT redacted_event_json AS redactedEventJson FROM provenance_events WHERE event_id = ?",
      )
      .all(event.eventId) as Array<{ redactedEventJson: string }>;
    assert.deepEqual(rows, [{ redactedEventJson: JSON.stringify(event) }]);
  } finally {
    database.close();
  }
});

test("preserves sequence order and per-session JSONL separation", async (t) => {
  const root = await temporaryProject(t, "sequence");
  const first = await capture(root, "session-a", "first");
  const second = await capture(root, "session-b", "second");
  const third = await capture(root, "session-a", "third");

  assert.deepEqual(
    [first, second, third].map(({ status, receipt }) => [status, receipt?.sequence]),
    [
      ["recorded", 1],
      ["recorded", 2],
      ["recorded", 3],
    ],
  );
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "session-a"))).map(({ eventId }) => eventId),
    [first.eventId, third.eventId],
  );
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "session-b"))).map(({ eventId }) => eventId),
    [second.eventId],
  );

  const database = new Database(join(root, DEFAULT_LEDGER), { readonly: true });
  try {
    const rows = database
      .prepare(
        "SELECT sequence, event_id AS eventId, vectorized FROM provenance_events ORDER BY sequence",
      )
      .all() as Array<{ sequence: number; eventId: string; vectorized: number }>;
    assert.deepEqual(rows, [first, second, third].map(({ eventId }, index) => ({
      sequence: index + 1,
      eventId,
      vectorized: 0,
    })));
  } finally {
    database.close();
  }
});

test("keeps JSONL when SQLite insertion fails", async (t) => {
  const root = await temporaryProject(t, "sqlite-failure");
  const databasePath = join(root, DEFAULT_LEDGER);
  new ProvenanceLedgerWriter(databasePath).close();
  const database = new Database(databasePath);
  database.exec(`
    CREATE TRIGGER reject_provenance_insert
    BEFORE INSERT ON provenance_events
    BEGIN
      SELECT RAISE(FAIL, 'forced insertion failure');
    END;
  `);
  database.close();

  const result = await capture(root, "failure-session", "retained");

  assert.equal(result.status, "degraded");
  assert.equal(result.receipt, undefined);
  assert.deepEqual(result.diagnostics.map(({ stage }) => stage), ["sqlite"]);
  assert.deepEqual(
    (await jsonlEvents(sessionJsonlPath(root, "failure-session"))).map(({ eventId }) => eventId),
    [result.eventId],
  );
  const readonlyDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      readonlyDatabase.prepare("SELECT COUNT(*) FROM provenance_events").pluck().get(),
      0,
    );
  } finally {
    readonlyDatabase.close();
  }
});
