import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import type { IProvenanceEmbeddingProvider } from "../provenance-contracts.js";
import {
  buildProvenanceEmbeddingContent,
  LocalProvenanceEmbeddingProvider,
  ProvenanceIndexer,
} from "../embed-provenance-events.js";
import { ProvenanceQueryService } from "../query-provenance-ledger.js";
import { ProvenanceLedgerRecoveryService } from "../recover-provenance-ledger.js";
import type {
  ProvenanceEventName,
  RedactedProvenanceEvent,
} from "../provenance-schemas.js";
import { ProvenanceLedgerWriter } from "../write-provenance-ledger.js";

const MODEL_ID = "deterministic/local-test-model";
const ALL_EVENT_CATEGORIES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const satisfies readonly ProvenanceEventName[];

class DeterministicEmbeddingProvider implements IProvenanceEmbeddingProvider {
  readonly indexBatches: string[][] = [];
  readonly queryBatches: string[][] = [];

  modelId(): string {
    return MODEL_ID;
  }

  async embed(content: string[]): Promise<Float32Array[]> {
    this.indexBatches.push([...content]);
    return content.map(deterministicVector);
  }

  async embedReadOnly(content: string[]): Promise<Float32Array[]> {
    this.queryBatches.push([...content]);
    return content.map(deterministicVector);
  }
}

type SemanticFixture = {
  root: string;
  databasePath: string;
  writer: ProvenanceLedgerWriter;
};

async function createFixture(
  t: TestContext,
  name: string,
): Promise<SemanticFixture> {
  const root = await mkdtemp(join(tmpdir(), `provenance-mvp-${name}-`));
  const databasePath = join(root, "provenance.db");
  const writer = new ProvenanceLedgerWriter(databasePath);
  t.after(async () => {
    try {
      writer.close();
    } catch {
      // A test may close the writer before opening its read-only query service.
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, databasePath, writer };
}

function semanticEvent(
  eventName: ProvenanceEventName,
  options: {
    eventId?: string;
    recordedAt?: string;
    sessionId?: string;
    workflowId?: string;
    toolName?: string;
    eventData?: unknown;
  } = {},
): RedactedProvenanceEvent {
  const eventId = options.eventId ?? randomUUID();
  const eventData = options.eventData ?? {
    prompt: `redacted semantic content for ${eventName}`,
  };
  return {
    schemaVersion: 1,
    eventId,
    recordedAt: options.recordedAt ?? "2026-07-20T00:00:00.000Z",
    harness: eventName === "SessionEnd" ? "claude-code" : "codex",
    eventName,
    sessionId: options.sessionId ?? "semantic-session",
    ...(options.workflowId === undefined
      ? {}
      : { workflowId: options.workflowId }),
    source: "orchestrator",
    role: "orchestrator",
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    cwd: "<PROJECT_ROOT>",
    eventData,
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: createHash("sha256")
      .update(JSON.stringify({ eventId, eventData }))
      .digest("hex"),
  };
}

function deterministicVector(content: string): Float32Array {
  const lower = content.toLowerCase();
  if (/timeout signature/u.test(lower)) return Float32Array.from([1, 0, 0, 0]);
  if (/permission denied/u.test(lower)) return Float32Array.from([0, 1, 0, 0]);
  if (/database|migration|sql/u.test(lower)) return Float32Array.from([0, 0, 1, 0]);
  if (/dog|canine|puppy|fetch/u.test(lower)) return Float32Array.from([0, 0, 0, 1]);

  const digest = createHash("sha256").update(content).digest();
  return Float32Array.from([
    (digest[0] ?? 1) + 1,
    (digest[1] ?? 1) + 1,
    (digest[2] ?? 1) + 1,
    (digest[3] ?? 1) + 1,
  ]);
}

function semanticState(databasePath: string): {
  embeddingCount: number;
  flags: Array<{ eventId: string; vectorized: number }>;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const embeddingCount = (
      database.prepare("SELECT COUNT(*) AS count FROM provenance_embeddings").get() as {
        count: number;
      }
    ).count;
    const flags = database
      .prepare(
        "SELECT event_id AS eventId, vectorized FROM provenance_events ORDER BY sequence ASC",
      )
      .all() as Array<{ eventId: string; vectorized: number }>;
    return { embeddingCount, flags };
  } finally {
    database.close();
  }
}

type RecoveredSemanticFixture = {
  root: string;
  databasePath: string;
  events: RedactedProvenanceEvent[];
  provider: DeterministicEmbeddingProvider;
  recoveryResult: Awaited<
    ReturnType<ProvenanceLedgerRecoveryService["recover"]>
  >;
};

async function createRecoveredSemanticFixture(
  t: TestContext,
  name: string,
): Promise<RecoveredSemanticFixture> {
  const root = await mkdtemp(join(tmpdir(), `provenance-recovered-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "store", "provenance.db");
  const jsonlDirectory = join(root, "jsonl");
  const jsonlPath = join(jsonlDirectory, "codex", "recovered.jsonl");
  await mkdir(join(root, "store"), { recursive: true });
  await mkdir(join(jsonlDirectory, "codex"), { recursive: true });

  const legacyDatabase = new Database(databasePath);
  try {
    legacyDatabase.exec(`
      CREATE TABLE provenance_sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE provenance_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        sanitized_payload_json TEXT NOT NULL
      );
      CREATE TABLE provenance_embeddings (
        event_id TEXT PRIMARY KEY,
        content_sha256 TEXT NOT NULL
      );
      CREATE TABLE provenance_integrity_issues (issue_id TEXT PRIMARY KEY);
      PRAGMA user_version = 0;
    `);
  } finally {
    legacyDatabase.close();
  }

  const events = [
    semanticEvent("UserPromptSubmit", {
      eventId: "11111111-1111-4111-8111-111111111111",
      recordedAt: "2026-07-20T00:00:01.000Z",
      workflowId: "workflow-recovered",
      eventData: { prompt: "A dog plays fetch with a ball." },
    }),
    semanticEvent("PostToolUse", {
      eventId: "22222222-2222-4222-8222-222222222222",
      recordedAt: "2026-07-20T00:00:02.000Z",
      workflowId: "workflow-recovered",
      toolName: "Bash",
      eventData: { tool_response: "Applied a database SQL migration." },
    }),
    semanticEvent("PostToolUseFailure", {
      eventId: "33333333-3333-4333-8333-333333333333",
      recordedAt: "2026-07-20T00:00:03.000Z",
      workflowId: "workflow-failure",
      toolName: "Bash",
      eventData: { error: "permission denied" },
    }),
  ];
  await writeFile(
    jsonlPath,
    `${[...events]
      .reverse()
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
    "utf8",
  );

  const provider = new DeterministicEmbeddingProvider();
  const recoveryResult = await new ProvenanceLedgerRecoveryService(
    databasePath,
    jsonlDirectory,
  ).recover({ mode: "apply" });
  return { root, databasePath, events, provider, recoveryResult };
}

test("marks every replayed event unindexed without loading a model", async (t) => {
  const fixture = await createRecoveredSemanticFixture(t, "unindexed");

  assert.equal(fixture.recoveryResult.status, "rebuilt");
  assert.equal(fixture.recoveryResult.semanticReindexRequired, true);
  assert.equal(fixture.recoveryResult.replayedEventCount, fixture.events.length);
  assert.deepEqual(semanticState(fixture.databasePath), {
    embeddingCount: 0,
    flags: fixture.events.map((event) => ({
      eventId: event.eventId,
      vectorized: 0,
    })),
  });
  assert.deepEqual(fixture.provider.indexBatches, []);
  assert.deepEqual(fixture.provider.queryBatches, []);
});

test("explicitly indexes recovered events in deterministic batches", async (t) => {
  const fixture = await createRecoveredSemanticFixture(t, "index-batches");

  const result = await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: fixture.provider,
  }).index({ batchSize: 2, dryRun: false });

  assert.deepEqual(result, {
    dryRun: false,
    eligibleCount: fixture.events.length,
    indexedCount: fixture.events.length,
    failedCount: 0,
    modelId: MODEL_ID,
  });
  assert.deepEqual(
    fixture.provider.indexBatches.map((batch) => batch.length),
    [2, 1],
  );
  assert.deepEqual(
    fixture.provider.indexBatches.flat(),
    fixture.events.map(buildProvenanceEmbeddingContent),
  );
  const state = semanticState(fixture.databasePath);
  assert.equal(state.embeddingCount, fixture.events.length);
  assert.ok(state.flags.every((row) => row.vectorized === 1));
});

test("searches rebuilt vectors without query-side mutation", async (t) => {
  const fixture = await createRecoveredSemanticFixture(t, "search-read-only");
  await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: fixture.provider,
  }).index({ batchSize: 2, dryRun: false });
  const before = semanticState(fixture.databasePath);
  const indexCallsBefore = fixture.provider.indexBatches.length;

  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
    embeddingProvider: fixture.provider,
  });
  const hits = await service.search({
    text: "Which recovered activity involved a canine fetching a toy?",
    limit: fixture.events.length,
  });

  assert.equal(hits[0]?.event.eventId, fixture.events[0]?.eventId);
  assert.equal(fixture.provider.indexBatches.length, indexCallsBefore);
  assert.equal(fixture.provider.queryBatches.length, 1);
  assert.deepEqual(semanticState(fixture.databasePath), before);
  service.close();
});

test("dry-run reports eligible events without mutation or model load", async (t) => {
  const fixture = await createFixture(t, "dry-run");
  for (const eventName of ALL_EVENT_CATEGORIES.slice(0, 3)) {
    fixture.writer.insert(semanticEvent(eventName));
  }
  const provider = new DeterministicEmbeddingProvider();
  const before = semanticState(fixture.databasePath);

  const result = await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  }).index({ batchSize: 2, dryRun: true });

  assert.deepEqual(result, {
    dryRun: true,
    eligibleCount: 3,
    indexedCount: 0,
    failedCount: 0,
  });
  assert.deepEqual(semanticState(fixture.databasePath), before);
  assert.equal(provider.indexBatches.length, 0);
  assert.equal(provider.queryBatches.length, 0);
});

test("indexes all event categories incrementally in positive batches", async (t) => {
  const fixture = await createFixture(t, "all-events");
  for (const eventName of ALL_EVENT_CATEGORIES) {
    fixture.writer.insert(
      semanticEvent(eventName, {
        sessionId: `session-${eventName}`,
        eventData: { prompt: `category ${eventName}` },
      }),
    );
  }
  const provider = new DeterministicEmbeddingProvider();
  const indexer = new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  });

  const first = await indexer.index({ batchSize: 3, dryRun: false });
  assert.deepEqual(first, {
    dryRun: false,
    eligibleCount: ALL_EVENT_CATEGORIES.length,
    indexedCount: ALL_EVENT_CATEGORIES.length,
    failedCount: 0,
    modelId: MODEL_ID,
  });
  assert.deepEqual(
    provider.indexBatches.map((batch) => batch.length),
    [3, 3, 3, 3],
  );
  const indexed = semanticState(fixture.databasePath);
  assert.equal(indexed.embeddingCount, ALL_EVENT_CATEGORIES.length);
  assert.ok(indexed.flags.every((row) => row.vectorized === 1));

  const callsAfterFirstIndex = provider.indexBatches.length;
  const second = await indexer.index({ batchSize: 5, dryRun: false });
  assert.equal(second.eligibleCount, 0);
  assert.equal(second.indexedCount, 0);
  assert.equal(provider.indexBatches.length, callsAfterFirstIndex);

  const database = new Database(fixture.databasePath, { readonly: true });
  const rows = database
    .prepare("SELECT dimensions, length(vector_blob) AS bytes FROM provenance_embeddings")
    .all() as Array<{ dimensions: number; bytes: number }>;
  database.close();
  assert.ok(rows.every((row) => row.dimensions === 4 && row.bytes === 16));
});

test("search ranks local Float32 vectors without mutating index state", async (t) => {
  const fixture = await createFixture(t, "search-read-only");
  const dogEvent = semanticEvent("UserPromptSubmit", {
    workflowId: "workflow-search",
    eventData: { prompt: "A dog plays fetch with a ball." },
  });
  const databaseEvent = semanticEvent("UserPromptSubmit", {
    workflowId: "workflow-search",
    eventData: { prompt: "Apply a database SQL migration." },
  });
  fixture.writer.insert(dogEvent);
  fixture.writer.insert(databaseEvent);
  const provider = new DeterministicEmbeddingProvider();
  await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  }).index({ batchSize: 2, dryRun: false });

  const cacheDirectory = join(fixture.root, "models");
  const cacheSentinel = join(cacheDirectory, "sentinel.txt");
  await mkdir(cacheDirectory);
  await writeFile(cacheSentinel, "cache-must-remain-byte-identical", "utf8");
  const stateBeforeQuery = semanticState(fixture.databasePath);
  const sentinelBeforeQuery = await readFile(cacheSentinel, "utf8");
  const indexCallsBeforeQuery = provider.indexBatches.length;

  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  });
  const hits = await service.search({
    text: "Which activity involved a canine fetching a toy?",
    limit: 2,
  });

  assert.equal(hits[0]?.event.eventId, dogEvent.eventId);
  assert.ok(hits.every((hit) => hit.event.vectorized));
  assert.equal(provider.indexBatches.length, indexCallsBeforeQuery);
  assert.equal(provider.queryBatches.length, 1);
  assert.deepEqual(semanticState(fixture.databasePath), stateBeforeQuery);
  assert.equal(await readFile(cacheSentinel, "utf8"), sentinelBeforeQuery);
  service.close();
});

test("similar defaults to same workflow and expands only when requested", async (t) => {
  const fixture = await createFixture(t, "similar-workflows");
  const source = semanticEvent("UserPromptSubmit", {
    workflowId: "workflow-alpha",
    eventData: { prompt: "A dog plays fetch." },
  });
  const sameWorkflow = semanticEvent("PostToolUse", {
    workflowId: "workflow-alpha",
    eventData: { tool_response: "A canine retrieves a ball." },
  });
  const otherWorkflow = semanticEvent("UserPromptSubmit", {
    workflowId: "workflow-beta",
    eventData: { prompt: "A puppy likes fetch." },
  });
  for (const event of [source, sameWorkflow, otherWorkflow]) {
    fixture.writer.insert(event);
  }
  const provider = new DeterministicEmbeddingProvider();
  await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  }).index({ batchSize: 2, dryRun: false });
  const stateBeforeQueries = semanticState(fixture.databasePath);

  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  });
  const sameOnly = await service.findSimilar(source.eventId, false, 10);
  assert.deepEqual(
    sameOnly.map((hit) => hit.event.eventId),
    [sameWorkflow.eventId],
  );
  const across = await service.findSimilar(source.eventId, true, 10);
  assert.deepEqual(
    new Set(across.map((hit) => hit.event.eventId)),
    new Set([sameWorkflow.eventId, otherWorkflow.eventId]),
  );
  assert.ok(across.every((hit) => hit.event.eventId !== source.eventId));
  assert.deepEqual(semanticState(fixture.databasePath), stateBeforeQueries);
  service.close();
});

test("patterns excludes self and requires a different workflow match", async (t) => {
  const fixture = await createFixture(t, "patterns");
  const source = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-source",
    toolName: "Bash",
    eventData: { error: "timeout signature" },
  });
  const sameWorkflow = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-source",
    toolName: "Bash",
    eventData: { error: "permission denied" },
  });
  const semanticPeer = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-peer",
    toolName: "Bash",
    eventData: { error: "timeout signature" },
  });
  const unrelatedPeer = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-other",
    toolName: "Bash",
    eventData: { error: "permission denied" },
  });
  for (const event of [source, sameWorkflow, semanticPeer, unrelatedPeer]) {
    fixture.writer.insert(event);
  }
  const provider = new DeterministicEmbeddingProvider();
  await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  }).index({ batchSize: 2, dryRun: false });

  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  });
  const semantic = await service.findPatterns({
    workflowId: "workflow-source",
    threshold: 0.99,
    limit: 10,
  });
  assert.equal(semantic.usedStructuredFallback, false);
  assert.ok(
    semantic.matches.some(
      (match) => match.relatedFailure.eventId === semanticPeer.eventId,
    ),
  );
  assert.ok(
    semantic.matches.every(
      (match) =>
        match.failure.eventId !== match.relatedFailure.eventId &&
        match.failure.workflowId !== match.relatedFailure.workflowId,
    ),
  );

  const unindexedPeer = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-new",
    toolName: "Bash",
    eventData: { error: "timeout signature" },
  });
  fixture.writer.insert(unindexedPeer);
  const stateBeforePartialQuery = semanticState(fixture.databasePath);
  const partial = await service.findPatterns({
    workflowId: "workflow-source",
    threshold: 0.99,
    limit: 10,
  });
  assert.equal(partial.usedStructuredFallback, true);
  assert.ok(
    partial.matches.some(
      (match) => match.relatedFailure.eventId === unindexedPeer.eventId,
    ),
  );
  assert.ok(
    partial.matches.every(
      (match) =>
        match.failure.eventId !== match.relatedFailure.eventId &&
        match.failure.workflowId !== match.relatedFailure.workflowId,
    ),
  );
  assert.deepEqual(semanticState(fixture.databasePath), stateBeforePartialQuery);
  service.close();
});

test("patterns reports structured fallback use even when it finds no match", async (t) => {
  const fixture = await createFixture(t, "patterns-empty-fallback");
  fixture.writer.insert(
    semanticEvent("PostToolUseFailure", {
      workflowId: "workflow-source",
      toolName: "Bash",
      eventData: { error: "timeout signature" },
    }),
  );
  fixture.writer.insert(
    semanticEvent("PostToolUseFailure", {
      workflowId: "workflow-unrelated",
      toolName: "Edit",
      eventData: { error: "unrelated permission signature" },
    }),
  );
  const service = new ProvenanceQueryService({ databasePath: fixture.databasePath });
  const result = await service.findPatterns({
    workflowId: "workflow-source",
    threshold: 1,
    limit: 10,
  });
  assert.equal(result.usedStructuredFallback, true);
  assert.deepEqual(result.matches, []);
  service.close();
});

test("patterns reports fallback when only part of the candidate set is indexed", async (t) => {
  const fixture = await createFixture(t, "patterns-partial-empty-fallback");
  const source = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-source",
    toolName: "Bash",
    eventData: { error: "timeout signature" },
  });
  const indexedPeer = semanticEvent("PostToolUseFailure", {
    workflowId: "workflow-indexed",
    toolName: "Edit",
    eventData: { error: "permission signature" },
  });
  fixture.writer.insert(source);
  fixture.writer.insert(indexedPeer);
  const provider = new DeterministicEmbeddingProvider();
  await new ProvenanceIndexer({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  }).index({ batchSize: 10, dryRun: false });
  fixture.writer.insert(
    semanticEvent("PostToolUseFailure", {
      workflowId: "workflow-unindexed",
      toolName: "Read",
      eventData: { error: "missing file signature" },
    }),
  );
  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
    embeddingProvider: provider,
  });
  const result = await service.findPatterns({
    workflowId: "workflow-source",
    threshold: 1,
    limit: 10,
  });
  assert.equal(result.usedStructuredFallback, true);
  service.close();
});

test("missing model and absent cache degrade without query-side mutation", async (t) => {
  const fixture = await createFixture(t, "missing-model");
  fixture.writer.insert(
    semanticEvent("UserPromptSubmit", {
      workflowId: "workflow-structured",
      eventData: { prompt: "Structured activity remains queryable." },
    }),
  );
  const before = semanticState(fixture.databasePath);
  const service = new ProvenanceQueryService({
    databasePath: fixture.databasePath,
  });
  assert.equal(service.listEvents({ limit: 10 }).length, 1);
  await assert.rejects(
    service.search({ text: "structured activity", limit: 1 }),
    /semantic model support is unavailable.*index first/iu,
  );
  assert.deepEqual(semanticState(fixture.databasePath), before);

  const absentCache = join(fixture.root, "absent-model-cache");
  const localProvider = new LocalProvenanceEmbeddingProvider(absentCache);
  await assert.rejects(
    localProvider.embedReadOnly(["read-only query"]),
    /model cache is unavailable.*index first/iu,
  );
  await assert.rejects(access(absentCache), { code: "ENOENT" });
  service.close();
});
