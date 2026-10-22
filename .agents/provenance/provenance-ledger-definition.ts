import { existsSync } from "node:fs";

import Database from "better-sqlite3";

import type { IProvenanceLedgerSchemaInspector } from "./provenance-contracts.js";
import {
  ProvenanceLedgerSchemaInspectionSchema,
  type ProvenanceLedgerSchemaInspection,
  type ProvenanceLedgerSchemaReasonCode,
  type ProvenanceLedgerTableInspection,
} from "./provenance-ledger-schemas.js";

export const PROVENANCE_LEDGER_USER_VERSION = 1 as const;

export const PROVENANCE_LEDGER_REQUIRED_COLUMNS: Readonly<
  Record<"provenance_events" | "provenance_embeddings", readonly string[]>
> = {
  provenance_events: [
    "agent_id",
    "agent_type",
    "content_sha256",
    "cwd",
    "event_id",
    "event_name",
    "harness",
    "recorded_at",
    "redacted_event_json",
    "role",
    "schema_version",
    "sequence",
    "session_id",
    "source",
    "task_id",
    "tool_name",
    "tool_use_id",
    "transcript_path",
    "vectorized",
    "workflow_id",
  ],
  provenance_embeddings: [
    "dimensions",
    "document",
    "event_id",
    "indexed_at",
    "model_id",
    "vector_blob",
  ],
};

const PROVENANCE_LEDGER_TABLES = [
  "provenance_events",
  "provenance_embeddings",
] as const;

export function provenanceLedgerRecoveryMarkerPath(databasePath: string): string {
  return `${databasePath}.recovery.lock`;
}

export function createCurrentProvenanceLedgerSchema(
  database: Database.Database,
): void {
  const createSchema = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS provenance_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        schema_version INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workflow_id TEXT,
        task_id TEXT,
        event_name TEXT NOT NULL,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_id TEXT,
        agent_type TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        cwd TEXT NOT NULL,
        transcript_path TEXT,
        redacted_event_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        vectorized INTEGER NOT NULL DEFAULT 0 CHECK (vectorized IN (0, 1))
      );

      CREATE INDEX IF NOT EXISTS provenance_events_session_sequence
        ON provenance_events(harness, session_id, sequence);
      CREATE INDEX IF NOT EXISTS provenance_events_workflow_sequence
        ON provenance_events(workflow_id, sequence);
      CREATE INDEX IF NOT EXISTS provenance_events_event_sequence
        ON provenance_events(event_name, sequence);
      CREATE INDEX IF NOT EXISTS provenance_events_actor_sequence
        ON provenance_events(agent_id, agent_type, sequence);
      CREATE INDEX IF NOT EXISTS provenance_events_recorded_at
        ON provenance_events(recorded_at, sequence);
      CREATE INDEX IF NOT EXISTS provenance_events_vectorized
        ON provenance_events(vectorized, sequence);

      CREATE TABLE IF NOT EXISTS provenance_embeddings (
        event_id TEXT PRIMARY KEY REFERENCES provenance_events(event_id),
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        document TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      PRAGMA user_version = ${PROVENANCE_LEDGER_USER_VERSION};
    `);
  });
  createSchema();
}

type SqliteMasterTableRow = { name: string };
type SqliteTableInfoRow = { name: string };

export class ProvenanceLedgerSchemaDriftError extends Error {
  readonly code = "PROVENANCE_LEDGER_SCHEMA_DRIFT" as const;
  readonly inspection: ProvenanceLedgerSchemaInspection;

  constructor(inspection: ProvenanceLedgerSchemaInspection) {
    super(
      "The provenance ledger is not ready for current queries. Run node scripts/init.mjs to inspect and recover it.",
    );
    this.name = "ProvenanceLedgerSchemaDriftError";
    this.inspection = inspection;
  }
}

export class ProvenanceLedgerSchemaInspector
  implements IProvenanceLedgerSchemaInspector
{
  inspect(databasePath: string): ProvenanceLedgerSchemaInspection {
    const recoveryMarkerPresent = existsSync(
      provenanceLedgerRecoveryMarkerPath(databasePath),
    );
    if (!existsSync(databasePath)) {
      return ProvenanceLedgerSchemaInspectionSchema.parse({
        schemaVersion: 1,
        databasePath,
        databaseExists: false,
        recoveryMarkerPresent,
        expectedUserVersion: PROVENANCE_LEDGER_USER_VERSION,
        state: "missing",
        tables: [],
        reasonCodes: [
          "database-missing",
          ...(recoveryMarkerPresent ? ["recovery-marker-present" as const] : []),
        ],
      });
    }

    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const observedUserVersion = database.pragma("user_version", {
        simple: true,
      }) as number;
      const observedTables = new Set(
        (
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
            )
            .all(...PROVENANCE_LEDGER_TABLES) as SqliteMasterTableRow[]
        ).map((row) => row.name),
      );
      const reasonCodes: ProvenanceLedgerSchemaReasonCode[] = [];
      if (recoveryMarkerPresent) {
        reasonCodes.push("recovery-marker-present");
      }
      if (observedUserVersion !== 0 && observedUserVersion !== 1) {
        reasonCodes.push("unsupported-user-version");
      }

      const tables: ProvenanceLedgerTableInspection[] =
        PROVENANCE_LEDGER_TABLES.map((tableName) => {
          const requiredColumns = [...PROVENANCE_LEDGER_REQUIRED_COLUMNS[tableName]];
          if (!observedTables.has(tableName)) {
            if (!reasonCodes.includes("required-table-missing")) {
              reasonCodes.push("required-table-missing");
            }
            return {
              tableName,
              requiredColumns,
              observedColumns: [],
              missingColumns: requiredColumns,
            };
          }

          const observedColumns = (
            database.pragma(`table_info(${tableName})`) as SqliteTableInfoRow[]
          )
            .map((row) => row.name)
            .sort();
          const observedColumnSet = new Set(observedColumns);
          const missingColumns = requiredColumns.filter(
            (column) => !observedColumnSet.has(column),
          );
          if (
            missingColumns.length > 0 &&
            !reasonCodes.includes("required-column-missing")
          ) {
            reasonCodes.push("required-column-missing");
          }
          return {
            tableName,
            requiredColumns,
            observedColumns,
            missingColumns,
          };
        });

      const structurallyCompatible = tables.every(
        (table) => table.missingColumns.length === 0,
      );
      const state =
        structurallyCompatible && observedUserVersion === 1
          ? "current"
          : structurallyCompatible && observedUserVersion === 0
            ? "unstamped-current"
            : "incompatible";

      return ProvenanceLedgerSchemaInspectionSchema.parse({
        schemaVersion: 1,
        databasePath,
        databaseExists: true,
        recoveryMarkerPresent,
        expectedUserVersion: PROVENANCE_LEDGER_USER_VERSION,
        observedUserVersion,
        state,
        tables,
        reasonCodes,
      });
    } finally {
      database.close();
    }
  }

  assertCompatible(databasePath: string): ProvenanceLedgerSchemaInspection {
    const inspection = this.inspect(databasePath);
    if (
      inspection.recoveryMarkerPresent ||
      inspection.state === "incompatible" ||
      inspection.state === "missing"
    ) {
      throw new ProvenanceLedgerSchemaDriftError(inspection);
    }
    return inspection;
  }
}
