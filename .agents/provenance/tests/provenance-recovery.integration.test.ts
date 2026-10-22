import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import type { IProvenanceJsonlReplayReader } from "../provenance-contracts.js";
import {
  PROVENANCE_LEDGER_USER_VERSION,
  provenanceLedgerRecoveryMarkerPath,
  ProvenanceLedgerSchemaInspector,
} from "../provenance-ledger-definition.js";
import type { ValidatedProvenanceJsonlReplay } from "../provenance-ledger-schemas.js";
import type { RedactedProvenanceEvent } from "../provenance-schemas.js";
import { ProvenanceJsonlReplayReader } from "../read-provenance-jsonl-replay.js";
import {
  ProvenanceLedgerRecoveryBlockedError,
  ProvenanceLedgerRecoveryCleanupError,
  ProvenanceLedgerRecoveryService,
} from "../recover-provenance-ledger.js";
import { ProvenanceLedgerWriter } from "../write-provenance-ledger.js";

const LEGACY_FOUR_TABLE_DDL = `
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
`;

type RecoveryFixture = {
  root: string;
  databasePath: string;
  jsonlDirectory: string;
  jsonlPath: string;
};

async function recoveryFixture(
  t: TestContext,
  name: string,
): Promise<RecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), `provenance-recovery-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "store", "ledger.sqlite");
  const jsonlDirectory = join(root, "replay");
  const jsonlPath = join(jsonlDirectory, "codex", "session.jsonl");
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(dirname(jsonlPath), { recursive: true });
  return { root, databasePath, jsonlDirectory, jsonlPath };
}

function createLegacyFourTableLedger(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(LEGACY_FOUR_TABLE_DDL);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all();
    assert.deepEqual(tables, [
      "provenance_embeddings",
      "provenance_events",
      "provenance_integrity_issues",
      "provenance_sessions",
    ]);
    assert.equal(database.pragma("user_version", { simple: true }), 0);
  } finally {
    database.close();
  }
}

function createUnstampedCurrentLedger(databasePath: string): void {
  const writer = new ProvenanceLedgerWriter(databasePath);
  writer.close();
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("user_version = 0");
  } finally {
    database.close();
  }
}

function interruptedApplyPath(databasePath: string): string {
  return `${provenanceLedgerRecoveryMarkerPath(databasePath)}.interrupted`;
}

function persistValidSqliteSidecars(databasePath: string): {
  walBytes: Buffer;
  shmBytes: Buffer;
} {
  const database = new Database(databasePath);
  let walBytes: Buffer;
  let shmBytes: Buffer;
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    database
      .prepare(
        `INSERT INTO provenance_sessions (
           harness, session_id, started_at, ended_at, initial_cwd, final_cwd,
           source, integrity_status
         ) VALUES ('codex', 'legacy-session', '2026-07-20T00:00:00.000Z',
                   NULL, '.', '.', 'legacy', 'complete')`,
      )
      .run();
    database.pragma("wal_checkpoint(TRUNCATE)");
    walBytes = readFileSync(`${databasePath}-wal`);
    shmBytes = readFileSync(`${databasePath}-shm`);
  } finally {
    database.close();
  }
  writeFileSync(`${databasePath}-wal`, walBytes!);
  writeFileSync(`${databasePath}-shm`, shmBytes!);
  return { walBytes: walBytes!, shmBytes: shmBytes! };
}

function replayEvent(
  eventId: string,
  recordedAt: string,
  overrides: Partial<RedactedProvenanceEvent> = {},
): RedactedProvenanceEvent {
  return {
    schemaVersion: 1,
    eventId,
    recordedAt,
    harness: "codex",
    eventName: "PostToolUse",
    sessionId: "recovery-session",
    source: "main",
    role: "agent",
    toolName: "exec_command",
    cwd: ".",
    eventData: { status: "complete" },
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: eventId.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeReplayEvents(
  jsonlPath: string,
  events: RedactedProvenanceEvent[],
): Promise<void> {
  await writeFile(
    jsonlPath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

async function writeObservedPartialCorpus(
  jsonlDirectory: string,
): Promise<Map<string, Buffer>> {
  const fileBytes = new Map<string, Buffer>();
  let validEventIndex = 0;
  let invalidRecordIndex = 0;

  for (let fileIndex = 0; fileIndex < 7; fileIndex += 1) {
    const validLineCount = fileIndex < 5 ? 20 : 19;
    const lines: string[] = [];
    for (let lineIndex = 0; lineIndex < 45; lineIndex += 1) {
      if (lineIndex < validLineCount) {
        validEventIndex += 1;
        const hex = validEventIndex.toString(16).padStart(8, "0");
        lines.push(JSON.stringify(replayEvent(
          `${hex}-0000-4000-8000-${hex.padStart(12, "0")}`,
          new Date(Date.UTC(2026, 6, 20, 12, 0, validEventIndex)).toISOString(),
        )));
      } else {
        invalidRecordIndex += 1;
        lines.push(`legacy-record-${invalidRecordIndex}`);
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
    fileBytes.set(jsonlPath, bytes);
  }

  assert.equal(validEventIndex, 138);
  assert.equal(invalidRecordIndex, 177);
  return fileBytes;
}

function currentRows(databasePath: string): Array<{
  sequence: number;
  eventId: string;
  recordedAt: string;
  vectorized: number;
}> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT sequence, event_id AS eventId, recorded_at AS recordedAt, vectorized
         FROM provenance_events ORDER BY sequence`,
      )
      .all() as Array<{
      sequence: number;
      eventId: string;
      recordedAt: string;
      vectorized: number;
    }>;
  } finally {
    database.close();
  }
}

async function adjacentArchiveDirectories(databasePath: string): Promise<string[]> {
  const prefix = `${basename(databasePath)}.archive-`;
  return (await readdir(dirname(databasePath)))
    .filter((entry) => entry.startsWith(prefix))
    .sort();
}

function aggregateMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const messages = [error.message];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) messages.push(...aggregateMessages(nested));
  }
  if (error.cause !== undefined) messages.push(...aggregateMessages(error.cause));
  return messages;
}

test("durably creates a missing ledger when its parent directory is absent", async (t) => {
  const fixture = await recoveryFixture(t, "missing-transition");
  await rm(dirname(fixture.databasePath), { recursive: true, force: true });
  const event = replayEvent(
    "01010101-0101-4101-8101-010101010101",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);

  const service = new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  );
  const preview = await service.recover({ mode: "dry-run" });
  assert.equal(preview.status, "would-create");
  assert.equal(existsSync(fixture.databasePath), false);
  assert.equal(existsSync(dirname(fixture.databasePath)), false);

  const applied = await service.recover({ mode: "apply" });
  assert.equal(applied.status, "created");
  assert.equal(applied.after?.state, "current");
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    event.eventId,
  ]);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("durably stamps an unstamped current ledger after preview", async (t) => {
  const fixture = await recoveryFixture(t, "stamp-transition");
  createUnstampedCurrentLedger(fixture.databasePath);
  const service = new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  );

  const preview = await service.recover({ mode: "dry-run" });
  assert.equal(preview.status, "would-stamp");
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "unstamped-current",
  );

  const applied = await service.recover({ mode: "apply" });
  assert.equal(applied.status, "stamped");
  assert.equal(applied.after?.state, "current");
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("retry completes JSONL replay after partial missing-ledger creation", async (t) => {
  const fixture = await recoveryFixture(t, "retry-partial-create");
  const events = [
    replayEvent(
      "02020202-0202-4202-8202-020202020202",
      "2026-07-20T12:00:01.000Z",
    ),
    replayEvent(
      "03030303-0303-4303-8303-030303030303",
      "2026-07-20T12:00:02.000Z",
    ),
  ];
  await writeReplayEvents(fixture.jsonlPath, events);
  const injectedFailure = new Error("injected partial create replay failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      {
        afterReplayInsert: (insertedEventCount, databasePath) => {
          if (databasePath === fixture.databasePath && insertedEventCount === 1) {
            throw injectedFailure;
          }
        },
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );

  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(currentRows(fixture.databasePath).length, 1);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });
  assert.equal(retry.status, "created");
  assert.deepEqual(
    currentRows(fixture.databasePath).map((row) => row.eventId),
    events.map((event) => event.eventId),
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("retry closes a durable stamp transition after close reports failure", async (t) => {
  const fixture = await recoveryFixture(t, "retry-stamp-close");
  createUnstampedCurrentLedger(fixture.databasePath);
  const injectedFailure = new Error("injected stamp close failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { afterStampClose: () => { throw injectedFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });
  assert.equal(retry.status, "stamped");
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("previews legacy archive and deterministic replay without mutation", async (t) => {
  const fixture = await recoveryFixture(t, "dry-run");
  createLegacyFourTableLedger(fixture.databasePath);
  const later = replayEvent(
    "22222222-2222-4222-8222-222222222222",
    "2026-07-20T12:00:02.000Z",
  );
  const earlier = replayEvent(
    "11111111-1111-4111-8111-111111111111",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [later, earlier, earlier]);
  const beforeDatabaseBytes = await readFile(fixture.databasePath);
  const beforeJsonlBytes = await readFile(fixture.jsonlPath);
  const beforeDirectory = await readdir(dirname(fixture.databasePath));

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "dry-run" });

  assert.equal(result.status, "would-rebuild");
  assert.equal(result.replayedEventCount, 2);
  assert.equal(result.replay.validEventCount, 2);
  assert.equal(result.replay.duplicateEventCount, 1);
  assert.equal(result.archive, undefined);
  assert.equal(result.semanticReindexRequired, true);
  assert.deepEqual(await readFile(fixture.databasePath), beforeDatabaseBytes);
  assert.deepEqual(await readFile(fixture.jsonlPath), beforeJsonlBytes);
  assert.deepEqual(await readdir(dirname(fixture.databasePath)), beforeDirectory);
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
});

test("rebuilds the exact observed partial corpus and preserves all seven JSONL files byte-for-byte", async (t) => {
  const fixture = await recoveryFixture(t, "observed-partial-corpus");
  createLegacyFourTableLedger(fixture.databasePath);
  const jsonlBytes = await writeObservedPartialCorpus(fixture.jsonlDirectory);
  const databaseBytes = await readFile(fixture.databasePath);
  const service = new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  );

  const preview = await service.recover({ mode: "dry-run" });
  assert.equal(preview.status, "would-rebuild");
  assert.equal(preview.replay.jsonlFileCount, 7);
  assert.equal(preview.replay.nonBlankLineCount, 315);
  assert.equal(preview.replay.validEventCount, 138);
  assert.equal(preview.replay.invalidRecordCount, 177);
  assert.equal(preview.replay.conflictingEventCount, 0);
  assert.equal(preview.replay.disposition, "partial");
  assert.equal(preview.replay.skippedIssueCount, 177);
  assert.equal(preview.replay.blockingIssueCount, 0);
  assert.equal(preview.replay.issuesShown, 100);
  assert.equal(preview.replay.issuesTruncated, true);
  assert.equal(preview.nextAction.code, "apply-recovery");
  assert.deepEqual(await readFile(fixture.databasePath), databaseBytes);

  const applied = await service.recover({ mode: "apply" });
  assert.equal(applied.status, "rebuilt");
  assert.equal(applied.replayedEventCount, 138);
  assert.equal(applied.catchUpEventCount, 0);
  assert.equal(applied.replay.disposition, "partial");
  assert.equal(applied.replay.invalidRecordCount, 177);
  assert.equal(applied.nextAction.code, "review-skipped-replay-evidence");
  assert.equal(applied.semanticReindexRequired, true);
  assert.equal(currentRows(fixture.databasePath).length, 138);
  assert.ok(applied.archive);
  assert.deepEqual(await readFile(applied.archive.databaseFile), databaseBytes);
  for (const [jsonlPath, beforeBytes] of jsonlBytes) {
    assert.deepEqual(await readFile(jsonlPath), beforeBytes);
  }
});

test("rebuilds from invalid-only evidence without inserting or indexing records", async (t) => {
  const fixture = await recoveryFixture(t, "invalid-only-partial");
  createLegacyFourTableLedger(fixture.databasePath);
  const jsonlBytes = Buffer.from("{not-json\n{\"legacy\":true}\n", "utf8");
  await writeFile(fixture.jsonlPath, jsonlBytes);

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });

  assert.equal(result.status, "rebuilt");
  assert.equal(result.replay.disposition, "partial");
  assert.equal(result.replay.invalidRecordCount, 2);
  assert.equal(result.replay.validEventCount, 0);
  assert.equal(result.replayedEventCount, 0);
  assert.equal(result.catchUpEventCount, 0);
  assert.equal(result.semanticReindexRequired, false);
  assert.equal(result.nextAction.code, "review-skipped-replay-evidence");
  assert.deepEqual(currentRows(fixture.databasePath), []);
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
});

test("archives legacy database and sidecars then replays valid unique JSONL", async (t) => {
  const fixture = await recoveryFixture(t, "archive-replay");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  const later = replayEvent(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "2026-07-20T12:00:02.000Z",
  );
  const earlier = replayEvent(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [later, earlier, earlier]);

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });

  assert.equal(result.status, "rebuilt");
  assert.equal(result.after?.state, "current");
  assert.equal(result.after?.observedUserVersion, PROVENANCE_LEDGER_USER_VERSION);
  assert.equal(result.replayedEventCount, 2);
  assert.equal(result.catchUpEventCount, 0);
  assert.equal(result.semanticReindexRequired, true);
  assert.equal(result.recoveryMarkerCleared, true);
  assert.ok(result.archive);
  assert.equal(sha256(await readFile(result.archive.databaseFile)), sha256(databaseBytes));
  assert.equal(sha256(await readFile(result.archive.walFile!)), sha256(walBytes));
  assert.equal(sha256(await readFile(result.archive.shmFile!)), sha256(shmBytes));
  assert.deepEqual(currentRows(fixture.databasePath), [
    {
      sequence: 1,
      eventId: earlier.eventId,
      recordedAt: earlier.recordedAt,
      vectorized: 0,
    },
    {
      sequence: 2,
      eventId: later.eventId,
      recordedAt: later.recordedAt,
      vectorized: 0,
    },
  ]);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
});

test("post-swap failure leaves durable progress and the next apply resumes safely", async (t) => {
  const fixture = await recoveryFixture(t, "post-swap-progress");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  const event = replayEvent(
    "70707070-7070-4070-8070-707070707070",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);
  const jsonlBytes = await readFile(fixture.jsonlPath);
  const injectedFailure = new Error("injected post-swap failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { afterReplacementInstall: () => { throw injectedFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );

  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);
  const interruptedApply = JSON.parse(
    await readFile(interruptedApplyPath(fixture.databasePath), "utf8"),
  ) as {
    originalState: string;
    replayedEventCount: number;
    archive?: { databaseFile: string; walFile?: string; shmFile?: string };
  };
  assert.equal(interruptedApply.originalState, "incompatible");
  assert.equal(interruptedApply.replayedEventCount, 1);
  assert.ok(interruptedApply.archive);
  assert.deepEqual(
    await readFile(interruptedApply.archive.databaseFile),
    databaseBytes,
  );
  assert.deepEqual(await readFile(interruptedApply.archive.walFile!), walBytes);
  assert.deepEqual(await readFile(interruptedApply.archive.shmFile!), shmBytes);
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
  assert.deepEqual(currentRows(fixture.databasePath), [
    {
      sequence: 1,
      eventId: event.eventId,
      recordedAt: event.recordedAt,
      vectorized: 0,
    },
  ]);

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });

  assert.equal(retry.status, "rebuilt");
  assert.equal(retry.replayedEventCount, 1);
  assert.equal(retry.catchUpEventCount, 0);
  assert.deepEqual(retry.archive, interruptedApply.archive);
  assert.equal(retry.semanticReindexRequired, true);
  assert.equal(retry.nextAction.code, "run-semantic-index");
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    event.eventId,
  ]);
});

test("pre-install interruption resumes its validated prepared replacement", async (t) => {
  const fixture = await recoveryFixture(t, "pre-install-resume");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  const event = replayEvent(
    "71717171-7171-4171-8171-717171717171",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);
  const jsonlBytes = await readFile(fixture.jsonlPath);
  const injectedFailure = new Error("injected pre-install interruption");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { afterPreparedProgress: () => { throw injectedFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );

  assert.equal(existsSync(fixture.databasePath), false);
  assert.equal(existsSync(`${fixture.databasePath}-wal`), false);
  assert.equal(existsSync(`${fixture.databasePath}-shm`), false);
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
  const descriptorPath = interruptedApplyPath(fixture.databasePath);
  assert.equal(existsSync(descriptorPath), true);
  const interruptedApply = JSON.parse(
    await readFile(descriptorPath, "utf8"),
  ) as {
    replayedEventCount: number;
    replacementDatabaseFile: string;
    replacementDatabaseSha256: string;
    archive: { databaseFile: string; walFile: string; shmFile: string };
  };
  assert.equal(interruptedApply.replayedEventCount, 1);
  assert.equal(existsSync(interruptedApply.replacementDatabaseFile), true);
  assert.equal(
    sha256(await readFile(interruptedApply.replacementDatabaseFile)),
    interruptedApply.replacementDatabaseSha256,
  );
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(
      interruptedApply.replacementDatabaseFile,
    ).state,
    "current",
  );
  assert.deepEqual(await readFile(interruptedApply.archive.databaseFile), databaseBytes);
  assert.deepEqual(await readFile(interruptedApply.archive.walFile), walBytes);
  assert.deepEqual(await readFile(interruptedApply.archive.shmFile), shmBytes);
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });

  assert.equal(retry.status, "rebuilt");
  assert.equal(retry.replayedEventCount, 1);
  assert.equal(retry.catchUpEventCount, 0);
  assert.equal(retry.semanticReindexRequired, true);
  assert.equal(retry.nextAction.code, "run-semantic-index");
  assert.equal(existsSync(interruptedApply.replacementDatabaseFile), false);
  assert.equal(existsSync(descriptorPath), false);
  assert.deepEqual(await readFile(retry.archive!.databaseFile), databaseBytes);
  assert.deepEqual(await readFile(retry.archive!.walFile!), walBytes);
  assert.deepEqual(await readFile(retry.archive!.shmFile!), shmBytes);
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
  assert.deepEqual(currentRows(fixture.databasePath), [
    {
      sequence: 1,
      eventId: event.eventId,
      recordedAt: event.recordedAt,
      vectorized: 0,
    },
  ]);
});

test("prepared-replacement-byte-tamper rejects a current-schema prepared database modified at its legitimate path", async (t) => {
  const fixture = await recoveryFixture(t, "prepared-replacement-byte-tamper");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const replayedEvent = replayEvent(
    "74747474-7474-4474-8474-747474747474",
    "2026-07-20T12:00:01.000Z",
  );
  const alteredEvent = replayEvent(
    "75757575-7575-4575-8575-757575757575",
    "2026-07-20T12:00:02.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [replayedEvent]);
  const jsonlBytes = await readFile(fixture.jsonlPath);
  const injectedFailure = new Error("prepare replacement for byte tamper");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { afterPreparedProgress: () => { throw injectedFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );

  const descriptorPath = interruptedApplyPath(fixture.databasePath);
  const descriptorBytes = await readFile(descriptorPath);
  const interruptedApply = JSON.parse(descriptorBytes.toString("utf8")) as {
    replacementDatabaseFile: string;
    replacementDatabaseSha256: string;
    archive: { databaseFile: string; walFile: string; shmFile: string };
  };
  const preparedWriter = new ProvenanceLedgerWriter(
    interruptedApply.replacementDatabaseFile,
  );
  try {
    preparedWriter.insert(alteredEvent);
  } finally {
    preparedWriter.close();
  }
  const alteredPreparedBytes = await readFile(
    interruptedApply.replacementDatabaseFile,
  );
  assert.notEqual(
    sha256(alteredPreparedBytes),
    interruptedApply.replacementDatabaseSha256,
  );
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(
      interruptedApply.replacementDatabaseFile,
    ).state,
    "current",
  );
  assert.deepEqual(
    currentRows(interruptedApply.replacementDatabaseFile).map(
      (row) => row.eventId,
    ),
    [replayedEvent.eventId, alteredEvent.eventId],
  );
  const archivedDatabaseBytes = await readFile(
    interruptedApply.archive.databaseFile,
  );
  const archivedWalBytes = await readFile(interruptedApply.archive.walFile);
  const archivedShmBytes = await readFile(interruptedApply.archive.shmFile);
  assert.deepEqual(archivedDatabaseBytes, databaseBytes);
  assert.deepEqual(archivedWalBytes, walBytes);

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
    ).recover({ mode: "apply" }),
    (error: unknown) => error instanceof ProvenanceLedgerRecoveryBlockedError,
  );

  assert.equal(existsSync(fixture.databasePath), false);
  assert.equal(existsSync(`${fixture.databasePath}-wal`), false);
  assert.equal(existsSync(`${fixture.databasePath}-shm`), false);
  assert.equal(existsSync(interruptedApply.replacementDatabaseFile), true);
  assert.deepEqual(
    await readFile(interruptedApply.replacementDatabaseFile),
    alteredPreparedBytes,
  );
  assert.deepEqual(await readFile(descriptorPath), descriptorBytes);
  assert.deepEqual(
    await readFile(interruptedApply.archive.databaseFile),
    archivedDatabaseBytes,
  );
  assert.deepEqual(
    await readFile(interruptedApply.archive.walFile),
    archivedWalBytes,
  );
  assert.deepEqual(
    await readFile(interruptedApply.archive.shmFile),
    archivedShmBytes,
  );
  assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
  assert.equal(
    existsSync(join(fixture.root, ".agents", "data", "provenance", "models")),
    false,
  );
});

test("blocks substituted pre-install descriptor paths without consuming evidence", async (t) => {
  for (const substitutedPath of ["replacement", "archive"] as const) {
    await t.test(substitutedPath, async (t) => {
      const fixture = await recoveryFixture(t, `pre-install-${substitutedPath}`);
      createLegacyFourTableLedger(fixture.databasePath);
      const event = replayEvent(
        substitutedPath === "replacement"
          ? "72727272-7272-4272-8272-727272727272"
          : "73737373-7373-4373-8373-737373737373",
        "2026-07-20T12:00:01.000Z",
      );
      await writeReplayEvents(fixture.jsonlPath, [event]);
      const jsonlBytes = await readFile(fixture.jsonlPath);
      const injectedFailure = new Error("prepare descriptor for substitution");

      await assert.rejects(
        new ProvenanceLedgerRecoveryService(
          fixture.databasePath,
          fixture.jsonlDirectory,
          new ProvenanceLedgerSchemaInspector(),
          new ProvenanceJsonlReplayReader(),
          renameSync,
          { afterPreparedProgress: () => { throw injectedFailure; } },
        ).recover({ mode: "apply" }),
        (error: unknown) => error === injectedFailure,
      );

      const descriptorPath = interruptedApplyPath(fixture.databasePath);
      const interruptedApply = JSON.parse(
        await readFile(descriptorPath, "utf8"),
      ) as {
        replacementDatabaseFile: string;
        replacementDatabaseSha256: string;
        archive: { directory: string; databaseFile: string };
      };
      const legitimateReplacement = interruptedApply.replacementDatabaseFile;
      if (substitutedPath === "replacement") {
        interruptedApply.replacementDatabaseFile = fixture.jsonlPath;
        interruptedApply.replacementDatabaseSha256 = sha256(jsonlBytes);
      } else {
        interruptedApply.archive.databaseFile = fixture.jsonlPath;
      }
      await writeFile(descriptorPath, JSON.stringify(interruptedApply), "utf8");

      await assert.rejects(
        new ProvenanceLedgerRecoveryService(
          fixture.databasePath,
          fixture.jsonlDirectory,
        ).recover({ mode: "apply" }),
        (error: unknown) => error instanceof ProvenanceLedgerRecoveryBlockedError,
      );

      assert.equal(existsSync(fixture.databasePath), false);
      assert.equal(existsSync(legitimateReplacement), true);
      assert.equal(existsSync(descriptorPath), true);
      assert.deepEqual(await readFile(fixture.jsonlPath), jsonlBytes);
    });
  }
});

test("blocks apply on conflicting event IDs without moving the database", async (t) => {
  const cases: Array<{
    name: string;
    lines: string[];
  }> = [
    {
      name: "conflict",
      lines: [
        JSON.stringify(
          replayEvent(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "2026-07-20T12:00:01.000Z",
          ),
        ),
        JSON.stringify(
          replayEvent(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "2026-07-20T12:00:01.000Z",
            { eventData: { status: "conflict" }, contentSha256: "d".repeat(64) },
          ),
        ),
      ],
    },
    {
      name: "conflict-beyond-retained-diagnostics",
      lines: [
        JSON.stringify(
          replayEvent(
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "2026-07-20T12:00:01.000Z",
          ),
        ),
        ...Array.from({ length: 101 }, (_, index) => `invalid-${index}`),
        JSON.stringify(
          replayEvent(
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "2026-07-20T12:00:01.000Z",
            { eventData: { status: "conflict" }, contentSha256: "e".repeat(64) },
          ),
        ),
      ],
    },
  ];

  for (const blockedCase of cases) {
    await t.test(blockedCase.name, async (t) => {
      const fixture = await recoveryFixture(t, blockedCase.name);
      createLegacyFourTableLedger(fixture.databasePath);
      await writeFile(fixture.jsonlPath, `${blockedCase.lines.join("\n")}\n`, "utf8");
      const beforeDatabaseBytes = await readFile(fixture.databasePath);
      const beforeJsonlBytes = await readFile(fixture.jsonlPath);

      await assert.rejects(
        new ProvenanceLedgerRecoveryService(
          fixture.databasePath,
          fixture.jsonlDirectory,
        ).recover({ mode: "apply" }),
        (error: unknown) => {
          assert.equal(error instanceof ProvenanceLedgerRecoveryBlockedError, true);
          const blocked = error as ProvenanceLedgerRecoveryBlockedError;
          assert.equal(blocked.result.status, "blocked");
          assert.equal(blocked.result.replay.disposition, "blocked");
          assert.equal(blocked.result.replay.conflictingEventCount, 1);
          assert.equal(blocked.result.nextAction.code, "correct-replay-evidence");
          return true;
        },
      );

      assert.deepEqual(await readFile(fixture.databasePath), beforeDatabaseBytes);
      assert.deepEqual(await readFile(fixture.jsonlPath), beforeJsonlBytes);
      assert.deepEqual(await adjacentArchiveDirectories(fixture.databasePath), []);
      assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
      assert.equal(
        new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
        "incompatible",
      );
    });
  }
});

class CatchUpAppendingReplayReader implements IProvenanceJsonlReplayReader {
  private readCount = 0;

  constructor(
    private readonly delegate: ProvenanceJsonlReplayReader,
    private readonly jsonlPath: string,
    private readonly appendedEvents: RedactedProvenanceEvent[],
  ) {}

  async read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay> {
    this.readCount += 1;
    const replay = await this.delegate.read(jsonlDirectory);
    if (this.readCount === 2) {
      await appendFile(
        this.jsonlPath,
        `${this.appendedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
    }
    return replay;
  }
}

class CatchUpAppendingLinesReplayReader implements IProvenanceJsonlReplayReader {
  private readCount = 0;

  constructor(
    private readonly delegate: ProvenanceJsonlReplayReader,
    private readonly jsonlPath: string,
    private readonly appendedLines: string[],
  ) {}

  async read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay> {
    this.readCount += 1;
    const replay = await this.delegate.read(jsonlDirectory);
    if (this.readCount === 2) {
      await appendFile(this.jsonlPath, `${this.appendedLines.join("\n")}\n`, "utf8");
    }
    return replay;
  }
}

class ThrowingCatchUpReplayReader implements IProvenanceJsonlReplayReader {
  private readCount = 0;

  constructor(
    private readonly delegate: ProvenanceJsonlReplayReader,
    private readonly failure: Error,
  ) {}

  async read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay> {
    this.readCount += 1;
    if (this.readCount === 3) throw this.failure;
    return this.delegate.read(jsonlDirectory);
  }
}

class PartialCatchUpReplayReader implements IProvenanceJsonlReplayReader {
  private readCount = 0;

  constructor(private readonly delegate: ProvenanceJsonlReplayReader) {}

  async read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay> {
    this.readCount += 1;
    const replay = await this.delegate.read(jsonlDirectory);
    if (this.readCount !== 3) return replay;
    return {
      ...replay,
      nonBlankLineCount: replay.nonBlankLineCount + 1,
      invalidRecordCount: 1,
      disposition: "partial",
      skippedIssueCount: 1,
      blockingIssueCount: 0,
      issueCount: 1,
      issuesShown: 1,
      issuesTruncated: false,
      issues: [
        {
          relativePath: "codex/session.jsonl",
          lineNumber: replay.nonBlankLineCount + 1,
          disposition: "skipped",
          code: "invalid-json",
          sanitizedMessage: "Injected invalid catch-up record",
        },
      ],
    };
  }
}

test("catches JSONL appended during recovery without duplicate rows", async (t) => {
  const fixture = await recoveryFixture(t, "catch-up");
  createLegacyFourTableLedger(fixture.databasePath);
  const initial = replayEvent(
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "2026-07-20T12:00:01.000Z",
  );
  const appended = replayEvent(
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "2026-07-20T12:00:02.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [initial]);
  const replayReader = new CatchUpAppendingReplayReader(
    new ProvenanceJsonlReplayReader(),
    fixture.jsonlPath,
    [initial, appended],
  );

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
    new ProvenanceLedgerSchemaInspector(),
    replayReader,
  ).recover({ mode: "apply" });

  assert.equal(result.status, "rebuilt");
  assert.equal(result.replayedEventCount, 1);
  assert.equal(result.catchUpEventCount, 1);
  assert.deepEqual(currentRows(fixture.databasePath), [
    { sequence: 1, eventId: initial.eventId, recordedAt: initial.recordedAt, vectorized: 0 },
    { sequence: 3, eventId: appended.eventId, recordedAt: appended.recordedAt, vectorized: 0 },
  ]);
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
});

test("preserves and reports invalid JSONL appended during catch-up", async (t) => {
  const fixture = await recoveryFixture(t, "partial-catch-up-filesystem");
  createLegacyFourTableLedger(fixture.databasePath);
  const initial = replayEvent(
    "edededed-eded-4ded-8ded-edededededed",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [initial]);
  const replayReader = new CatchUpAppendingLinesReplayReader(
    new ProvenanceJsonlReplayReader(),
    fixture.jsonlPath,
    ["legacy-appended-during-recovery"],
  );

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
    new ProvenanceLedgerSchemaInspector(),
    replayReader,
  ).recover({ mode: "apply" });

  assert.equal(result.status, "rebuilt");
  assert.equal(result.replay.disposition, "partial");
  assert.equal(result.replay.invalidRecordCount, 1);
  assert.equal(result.replay.nonBlankLineCount, 2);
  assert.equal(result.nextAction.code, "review-skipped-replay-evidence");
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    initial.eventId,
  ]);
  assert.match(await readFile(fixture.jsonlPath, "utf8"), /legacy-appended-during-recovery/);
});

test("blocks a catch-up conflict beyond retained diagnostics after archival", async (t) => {
  const fixture = await recoveryFixture(t, "blocked-catch-up-conflict");
  createLegacyFourTableLedger(fixture.databasePath);
  const initial = replayEvent(
    "abababab-abab-4bab-8bab-abababababab",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [initial]);
  const conflicting = replayEvent(initial.eventId, initial.recordedAt, {
    eventData: { status: "conflict-after-archive" },
    contentSha256: "f".repeat(64),
  });
  const replayReader = new CatchUpAppendingLinesReplayReader(
    new ProvenanceJsonlReplayReader(),
    fixture.jsonlPath,
    [
      ...Array.from({ length: 101 }, (_, index) => `catch-up-invalid-${index}`),
      JSON.stringify(conflicting),
    ],
  );

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      replayReader,
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerRecoveryBlockedError, true);
      const blocked = error as ProvenanceLedgerRecoveryBlockedError;
      assert.equal(blocked.result.replay.disposition, "blocked");
      assert.equal(blocked.result.replay.invalidRecordCount, 101);
      assert.equal(blocked.result.replay.conflictingEventCount, 1);
      assert.equal(
        blocked.result.replay.issues.some((issue) => issue.code === "conflicting-event-id"),
        true,
      );
      return true;
    },
  );

  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);
  assert.equal((await adjacentArchiveDirectories(fixture.databasePath)).length, 1);
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    initial.eventId,
  ]);
});

test("retry completes recovery after throwing catch-up replay", async (t) => {
  const fixture = await recoveryFixture(t, "retry-throwing-catch-up");
  createLegacyFourTableLedger(fixture.databasePath);
  const event = replayEvent(
    "04040404-0404-4404-8404-040404040404",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);
  const injectedFailure = new Error("injected catch-up read failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ThrowingCatchUpReplayReader(
        new ProvenanceJsonlReplayReader(),
        injectedFailure,
      ),
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);
  assert.equal((await adjacentArchiveDirectories(fixture.databasePath)).length, 1);
  await appendFile(fixture.jsonlPath, "legacy-record-before-resume\n", "utf8");

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });
  assert.equal(retry.status, "rebuilt");
  assert.equal(retry.replay.disposition, "partial");
  assert.equal(retry.replay.invalidRecordCount, 1);
  assert.equal(retry.nextAction.code, "review-skipped-replay-evidence");
  assert.equal(retry.archive?.databaseFile.endsWith("ledger.sqlite"), true);
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    event.eventId,
  ]);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("completes recovery with the latest partial catch-up inventory", async (t) => {
  const fixture = await recoveryFixture(t, "partial-catch-up");
  createLegacyFourTableLedger(fixture.databasePath);
  const event = replayEvent(
    "05050505-0505-4505-8505-050505050505",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);

  const result = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
    new ProvenanceLedgerSchemaInspector(),
    new PartialCatchUpReplayReader(new ProvenanceJsonlReplayReader()),
  ).recover({ mode: "apply" });

  assert.equal(result.status, "rebuilt");
  assert.equal(result.replay.disposition, "partial");
  assert.equal(result.replay.invalidRecordCount, 1);
  assert.equal(result.replay.issues[0]?.disposition, "skipped");
  assert.equal(result.nextAction.code, "review-skipped-replay-evidence");
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    event.eventId,
  ]);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("retry completes recovery after final inspection fails", async (t) => {
  const fixture = await recoveryFixture(t, "retry-final-inspection");
  createLegacyFourTableLedger(fixture.databasePath);
  const event = replayEvent(
    "06060606-0606-4606-8606-060606060606",
    "2026-07-20T12:00:01.000Z",
  );
  await writeReplayEvents(fixture.jsonlPath, [event]);
  const injectedFailure = new Error("injected final inspection failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { beforeFinalInspection: () => { throw injectedFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === injectedFailure,
  );
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });
  assert.equal(retry.status, "rebuilt");
  assert.deepEqual(currentRows(fixture.databasePath).map((row) => row.eventId), [
    event.eventId,
  ]);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("restores the archived ledger when replacement installation fails", async (t) => {
  const fixture = await recoveryFixture(t, "rollback");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  await writeReplayEvents(fixture.jsonlPath, [
    replayEvent(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "2026-07-20T12:00:01.000Z",
    ),
  ]);
  const replacementFailure = new Error("injected replacement installation failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      () => {
        throw replacementFailure;
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === replacementFailure,
  );

  assert.equal(sha256(await readFile(fixture.databasePath)), sha256(databaseBytes));
  assert.equal(sha256(await readFile(`${fixture.databasePath}-wal`)), sha256(walBytes));
  assert.equal(sha256(await readFile(`${fixture.databasePath}-shm`)), sha256(shmBytes));
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  assert.equal(existsSync(provenanceLedgerRecoveryMarkerPath(fixture.databasePath)), false);
  assert.equal(
    (await readdir(dirname(fixture.databasePath))).some((entry) => entry.includes(".rebuild")),
    false,
  );
});

test("marker contention blocks dry-run and apply without moving ledger artifacts", async (t) => {
  const fixture = await recoveryFixture(t, "marker-contention");
  createLegacyFourTableLedger(fixture.databasePath);
  const databaseBytes = await readFile(fixture.databasePath);
  const markerPath = provenanceLedgerRecoveryMarkerPath(fixture.databasePath);
  writeFileSync(markerPath, JSON.stringify({ pid: process.pid }), "utf8");

  const service = new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  );
  const preview = await service.recover({ mode: "dry-run" });
  assert.equal(preview.status, "blocked");
  assert.equal(preview.recoveryMarkerCleared, false);

  await assert.rejects(
    service.recover({ mode: "apply" }),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerRecoveryBlockedError, true);
      assert.equal(
        (error as ProvenanceLedgerRecoveryBlockedError).result.recoveryMarkerCleared,
        false,
      );
      return true;
    },
  );
  assert.deepEqual(await readFile(fixture.databasePath), databaseBytes);
  assert.deepEqual(await adjacentArchiveDirectories(fixture.databasePath), []);
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
  assert.equal(existsSync(markerPath), true);
});

test("marker write and close failures still remove the exact acquired marker", async (t) => {
  for (const failurePoint of ["write", "close"] as const) {
    await t.test(failurePoint, async (t) => {
      const fixture = await recoveryFixture(t, `marker-${failurePoint}`);
      createLegacyFourTableLedger(fixture.databasePath);
      const failure = new Error(`injected marker ${failurePoint} failure`);
      const markerPath = provenanceLedgerRecoveryMarkerPath(fixture.databasePath);

      await assert.rejects(
        new ProvenanceLedgerRecoveryService(
          fixture.databasePath,
          fixture.jsonlDirectory,
          new ProvenanceLedgerSchemaInspector(),
          new ProvenanceJsonlReplayReader(),
          renameSync,
          failurePoint === "write"
            ? { writeRecoveryMarker: () => { throw failure; } }
            : {
                closeRecoveryMarker: (descriptor) => {
                  closeSync(descriptor);
                  throw failure;
                },
              },
        ).recover({ mode: "apply" }),
        (error: unknown) => {
          if (failurePoint === "write") return error === failure;
          assert.equal(error instanceof ProvenanceLedgerRecoveryCleanupError, true);
          assert.equal(aggregateMessages(error).includes(failure.message), true);
          return true;
        },
      );
      assert.equal(existsSync(markerPath), false);
      assert.equal(
        (await adjacentArchiveDirectories(fixture.databasePath)).length,
        failurePoint === "write" ? 0 : 1,
      );
    });
  }
});

test("marker cleanup failure preserves all causes and gives tokenized manual action", async (t) => {
  const fixture = await recoveryFixture(t, "marker-cleanup");
  createLegacyFourTableLedger(fixture.databasePath);
  const writeFailure = new Error("injected marker write failure");
  const closeFailure = new Error("injected marker close failure");
  const removeFailure = new Error("injected marker remove failure");
  const markerPath = provenanceLedgerRecoveryMarkerPath(fixture.databasePath);

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      {
        writeRecoveryMarker: () => { throw writeFailure; },
        closeRecoveryMarker: (descriptor) => {
          closeSync(descriptor);
          throw closeFailure;
        },
        removeRecoveryMarker: () => { throw removeFailure; },
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerRecoveryCleanupError, true);
      assert.match((error as Error).message, /Manually remove <ledger-adjacent>\/ledger\.sqlite\.recovery/);
      assert.equal((error as Error).message.includes(fixture.root), false);
      const messages = aggregateMessages(error);
      assert.equal(messages.includes(writeFailure.message), true);
      assert.equal(messages.includes(closeFailure.message), true);
      assert.equal(messages.includes(removeFailure.message), true);
      return true;
    },
  );
  assert.equal(existsSync(markerPath), true);
});

test("rollback source collision is explicit and preserves every archived artifact", async (t) => {
  const fixture = await recoveryFixture(t, "rollback-collision");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  const replacementFailure = new Error("injected replacement collision");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      (_temporaryPath, databasePath) => {
        writeFileSync(databasePath, "collision", "utf8");
        throw replacementFailure;
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.match((error as Error).message, /preserved archive: <ledger-adjacent>\/ledger\.sqlite\.archive-/);
      assert.equal((error as Error).message.includes(fixture.root), false);
      assert.equal(aggregateMessages(error).some((message) => message.includes("Rollback source collision")), true);
      return true;
    },
  );

  const [archiveDirectory] = await adjacentArchiveDirectories(fixture.databasePath);
  assert.ok(archiveDirectory);
  assert.equal(
    sha256(await readFile(join(dirname(fixture.databasePath), archiveDirectory, "ledger.sqlite"))),
    sha256(databaseBytes),
  );
  assert.equal(
    sha256(await readFile(join(dirname(fixture.databasePath), archiveDirectory, "ledger.sqlite-wal"))),
    sha256(walBytes),
  );
  assert.equal(
    sha256(await readFile(join(dirname(fixture.databasePath), archiveDirectory, "ledger.sqlite-shm"))),
    sha256(shmBytes),
  );
});

test("partial rollback reports the archive member that was not restored", async (t) => {
  const fixture = await recoveryFixture(t, "partial-rollback");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "incompatible",
  );
  const databaseBytes = await readFile(fixture.databasePath);
  const walBytes = await readFile(`${fixture.databasePath}-wal`);
  const shmBytes = await readFile(`${fixture.databasePath}-shm`);
  const rollbackFailure = new Error("injected WAL rollback failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      () => { throw new Error("injected replacement failure"); },
      {
        restoreArchivedArtifact: (source, destination) => {
          if (destination.endsWith("-wal")) throw rollbackFailure;
          renameSync(source, destination);
        },
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.match((error as Error).message, /preserved archive: <ledger-adjacent>\/ledger\.sqlite\.archive-/);
      assert.equal(aggregateMessages(error).includes(rollbackFailure.message), true);
      return true;
    },
  );

  assert.equal(sha256(await readFile(fixture.databasePath)), sha256(databaseBytes));
  assert.equal(sha256(await readFile(`${fixture.databasePath}-shm`)), sha256(shmBytes));
  assert.equal(existsSync(`${fixture.databasePath}-wal`), false);
  const [archiveDirectory] = await adjacentArchiveDirectories(fixture.databasePath);
  assert.ok(archiveDirectory);
  assert.equal(
    sha256(await readFile(join(dirname(fixture.databasePath), archiveDirectory, "ledger.sqlite-wal"))),
    sha256(walBytes),
  );
});

test("temporary writer close and artifact removal failures are aggregated", async (t) => {
  const fixture = await recoveryFixture(t, "temporary-cleanup");
  createLegacyFourTableLedger(fixture.databasePath);
  const databaseBytes = await readFile(fixture.databasePath);
  const closeFailure = new Error("injected temporary writer close failure");
  const removeFailure = new Error("injected temporary artifact remove failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      {
        closeReplayWriter: (writer) => {
          writer.close();
          throw closeFailure;
        },
        removeTemporaryArtifact: (temporaryPath) => {
          if (temporaryPath.includes(".rebuild")) throw removeFailure;
          rmSync(temporaryPath, { force: true });
        },
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerRecoveryCleanupError, true);
      const messages = aggregateMessages(error);
      assert.equal(messages.includes(closeFailure.message), true);
      assert.equal(messages.includes(removeFailure.message), true);
      return true;
    },
  );
  assert.deepEqual(await readFile(fixture.databasePath), databaseBytes);
  assert.deepEqual(await adjacentArchiveDirectories(fixture.databasePath), []);
});

test("stamp cleanup failure remains retryable and preserves its interrupted stamp", async (t) => {
  const fixture = await recoveryFixture(t, "stamp-cleanup");
  createUnstampedCurrentLedger(fixture.databasePath);
  const cleanupFailure = new Error("injected interrupted stamp cleanup failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      renameSync,
      { removeInterruptedApply: () => { throw cleanupFailure; } },
    ).recover({ mode: "apply" }),
    (error: unknown) => error === cleanupFailure,
  );
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), true);
  assert.equal(
    new ProvenanceLedgerSchemaInspector().inspect(fixture.databasePath).state,
    "current",
  );

  const retry = await new ProvenanceLedgerRecoveryService(
    fixture.databasePath,
    fixture.jsonlDirectory,
  ).recover({ mode: "apply" });
  assert.equal(retry.status, "stamped");
  assert.equal(existsSync(interruptedApplyPath(fixture.databasePath)), false);
});

test("combined replacement rollback and cleanup failure retains archive evidence", async (t) => {
  const fixture = await recoveryFixture(t, "combined-cleanup");
  createLegacyFourTableLedger(fixture.databasePath);
  persistValidSqliteSidecars(fixture.databasePath);
  const replacementFailure = new Error("injected replacement failure");
  const rollbackFailure = new Error("injected rollback failure");
  const cleanupFailure = new Error("injected cleanup failure");

  await assert.rejects(
    new ProvenanceLedgerRecoveryService(
      fixture.databasePath,
      fixture.jsonlDirectory,
      new ProvenanceLedgerSchemaInspector(),
      new ProvenanceJsonlReplayReader(),
      () => { throw replacementFailure; },
      {
        restoreArchivedArtifact: () => { throw rollbackFailure; },
        removeTemporaryArtifact: (temporaryPath) => {
          if (temporaryPath.includes(".rebuild")) throw cleanupFailure;
          rmSync(temporaryPath, { force: true });
        },
      },
    ).recover({ mode: "apply" }),
    (error: unknown) => {
      assert.equal(error instanceof ProvenanceLedgerRecoveryCleanupError, true);
      assert.match((error as Error).message, /preserved archive: <ledger-adjacent>\/ledger\.sqlite\.archive-/);
      assert.equal((error as Error).message.includes(fixture.root), false);
      const messages = aggregateMessages(error);
      assert.equal(messages.includes(replacementFailure.message), true);
      assert.equal(messages.includes(rollbackFailure.message), true);
      assert.equal(messages.includes(cleanupFailure.message), true);
      return true;
    },
  );
  assert.equal((await adjacentArchiveDirectories(fixture.databasePath)).length, 1);
});
