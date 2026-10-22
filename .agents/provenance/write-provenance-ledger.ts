import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { IProvenanceLedgerWriter } from "./provenance-contracts.js";
import {
  ProvenanceReplayInsertResultSchema,
  type ProvenanceReplayInsertResult,
} from "./provenance-ledger-schemas.js";
import {
  createCurrentProvenanceLedgerSchema,
  ProvenanceLedgerSchemaInspector,
} from "./provenance-ledger-definition.js";
import {
  ProvenanceEmbeddingSchema,
  ProvenanceRecordReceiptSchema,
  RedactedProvenanceEventSchema,
  type ProvenanceEmbedding,
  type ProvenanceRecordReceipt,
  type RedactedProvenanceEvent,
} from "./provenance-schemas.js";

type ProvenanceEmbeddingDatabaseRow = {
  event_id: string;
  model_id: string;
  dimensions: number;
  vector_blob: Buffer;
  document: string;
  indexed_at: string;
};

type ExistingProvenanceEventRow = {
  sequence: number;
  session_id: string;
  redacted_event_json: string;
};

/**
 * Owns the best-effort SQLite query mirror. JSONL ordering is deliberately
 * owned by the capture composition root, not by this persistence class.
 */
export class ProvenanceLedgerWriter implements IProvenanceLedgerWriter {
  private readonly database: Database.Database;

  constructor(databasePath: string, busyTimeoutMs = 5_000) {
    const databaseWasMissing = !existsSync(databasePath);
    const schemaInspector = new ProvenanceLedgerSchemaInspector();
    const initialInspection = schemaInspector.inspect(databasePath);
    if (initialInspection.recoveryMarkerPresent) {
      schemaInspector.assertCompatible(databasePath);
    }
    if (!databaseWasMissing) {
      schemaInspector.assertCompatible(databasePath);
    }

    if (databaseWasMissing) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath);
    this.database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    if (databaseWasMissing) {
      createCurrentProvenanceLedgerSchema(this.database);
    }
  }

  insert(provenanceEvent: RedactedProvenanceEvent): ProvenanceRecordReceipt {
    const event = RedactedProvenanceEventSchema.parse(provenanceEvent);
    const insertion = this.database
      .prepare(
        `INSERT INTO provenance_events (
           event_id, schema_version, recorded_at, harness, session_id,
           workflow_id, task_id, event_name, source, role, agent_id,
           agent_type, tool_name, tool_use_id, cwd, transcript_path,
           redacted_event_json, content_sha256, vectorized
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
         )`,
      )
      .run(
        event.eventId,
        event.schemaVersion,
        event.recordedAt,
        event.harness,
        event.sessionId,
        event.workflowId ?? null,
        event.taskId ?? null,
        event.eventName,
        event.source,
        event.role,
        event.agentId ?? null,
        event.agentType ?? null,
        event.toolName ?? null,
        event.toolUseId ?? null,
        event.cwd,
        event.transcriptPath ?? null,
        JSON.stringify(event),
        event.contentSha256,
      );

    return ProvenanceRecordReceiptSchema.parse({
      sequence: Number(insertion.lastInsertRowid),
      eventId: event.eventId,
      sessionId: event.sessionId,
    });
  }

  insertIfAbsent(
    provenanceEvent: RedactedProvenanceEvent,
  ): ProvenanceReplayInsertResult {
    const event = RedactedProvenanceEventSchema.parse(provenanceEvent);
    const redactedEventJson = JSON.stringify(event);
    const insertTransaction = this.database.transaction(() => {
      const insertion = this.database
        .prepare(
          `INSERT INTO provenance_events (
             event_id, schema_version, recorded_at, harness, session_id,
             workflow_id, task_id, event_name, source, role, agent_id,
             agent_type, tool_name, tool_use_id, cwd, transcript_path,
             redacted_event_json, content_sha256, vectorized
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
           )
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(
          event.eventId,
          event.schemaVersion,
          event.recordedAt,
          event.harness,
          event.sessionId,
          event.workflowId ?? null,
          event.taskId ?? null,
          event.eventName,
          event.source,
          event.role,
          event.agentId ?? null,
          event.agentType ?? null,
          event.toolName ?? null,
          event.toolUseId ?? null,
          event.cwd,
          event.transcriptPath ?? null,
          redactedEventJson,
          event.contentSha256,
        );

      if (insertion.changes === 1) {
        return ProvenanceReplayInsertResultSchema.parse({
          inserted: true,
          receipt: {
            sequence: Number(insertion.lastInsertRowid),
            eventId: event.eventId,
            sessionId: event.sessionId,
          },
        });
      }

      const existing = this.database
        .prepare(
          `SELECT sequence, session_id, redacted_event_json
           FROM provenance_events WHERE event_id = ?`,
        )
        .get(event.eventId) as ExistingProvenanceEventRow | undefined;
      if (existing === undefined || existing.redacted_event_json !== redactedEventJson) {
        throw new Error(
          `Conflicting provenance eventId reuse: ${event.eventId}`,
        );
      }

      return ProvenanceReplayInsertResultSchema.parse({ inserted: false });
    });

    return insertTransaction();
  }

  /** Compatibility alias retained until the semantic/query section migrates. */
  record(provenanceEvent: RedactedProvenanceEvent): ProvenanceRecordReceipt {
    return this.insert(provenanceEvent);
  }

  /**
   * Compatibility surface for the staged semantic implementation. Explicit
   * indexing remains outside capture and is the only caller that writes here.
   */
  write(embedding: ProvenanceEmbedding, document?: string): void {
    const parsedEmbedding = ProvenanceEmbeddingSchema.parse(embedding);
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO provenance_embeddings (
             event_id, model_id, dimensions, vector_blob, document, indexed_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             model_id = excluded.model_id,
             dimensions = excluded.dimensions,
             vector_blob = excluded.vector_blob,
             document = excluded.document,
             indexed_at = excluded.indexed_at`,
        )
        .run(
          parsedEmbedding.eventId,
          parsedEmbedding.modelId,
          parsedEmbedding.dimensions,
          Buffer.from(
            parsedEmbedding.vector.buffer,
            parsedEmbedding.vector.byteOffset,
            parsedEmbedding.vector.byteLength,
          ),
          document ?? parsedEmbedding.contentSha256,
          parsedEmbedding.embeddedAt,
        );
      this.markEmbeddingWritten(parsedEmbedding.eventId);
    });
    transaction();
  }

  find(eventId: string): ProvenanceEmbedding | undefined {
    const row = this.database
      .prepare(
        `SELECT event_id, model_id, dimensions, vector_blob, document, indexed_at
         FROM provenance_embeddings WHERE event_id = ?`,
      )
      .get(eventId) as ProvenanceEmbeddingDatabaseRow | undefined;
    if (row === undefined) return undefined;

    const vectorBytes = Uint8Array.from(
      new Uint8Array(
        row.vector_blob.buffer,
        row.vector_blob.byteOffset,
        row.vector_blob.byteLength,
      ),
    );
    return ProvenanceEmbeddingSchema.parse({
      eventId: row.event_id,
      modelId: row.model_id,
      dimensions: row.dimensions,
      vector: new Float32Array(vectorBytes.buffer),
      contentSha256: row.document,
      embeddedAt: row.indexed_at,
    });
  }

  markEmbeddingWritten(eventId: string): void {
    this.database
      .prepare("UPDATE provenance_events SET vectorized = 1 WHERE event_id = ?")
      .run(eventId);
  }

  markEmbeddingFailed(eventId: string): void {
    this.database
      .prepare("UPDATE provenance_events SET vectorized = 0 WHERE event_id = ?")
      .run(eventId);
  }

  close(): void {
    this.database.close();
  }

}
