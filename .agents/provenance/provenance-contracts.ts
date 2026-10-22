import type {
  HarnessId,
  PersistedProvenanceEvent,
  ProvenanceActorContext,
  ProvenanceAgentSummary,
  ProvenanceCaptureResult,
  ProvenanceIndexRequest,
  ProvenanceIndexResult,
  ProvenancePatternQuery,
  ProvenancePatternResult,
  ProvenanceQueryFilter,
  ProvenanceRecordReceipt,
  ProvenanceSearchHit,
  ProvenanceSemanticQuery,
  ProvenanceSessionSummary,
  RedactedProvenanceEvent,
  ValidatedProvenanceEvent,
} from "./provenance-schemas.js";
import type {
  ProvenanceLedgerRecoveryRequest,
  ProvenanceLedgerRecoveryResult,
  ProvenanceLedgerSchemaInspection,
  ProvenanceReplayInsertResult,
  ValidatedProvenanceJsonlReplay,
} from "./provenance-ledger-schemas.js";

export interface IProvenanceHarnessAdapter {
  normalize(
    rawHookEvent: unknown,
    recordedAt: string,
  ): ValidatedProvenanceEvent;
}

export interface IProvenanceActorResolver {
  resolve(event: ValidatedProvenanceEvent): ProvenanceActorContext;
}

export interface IProvenanceRedactor {
  redact(
    event: ValidatedProvenanceEvent,
    actorContext: ProvenanceActorContext,
  ): RedactedProvenanceEvent;
}

export interface IProvenanceJsonlMirror {
  append(event: RedactedProvenanceEvent): Promise<string>;
}

export interface IProvenanceLedgerWriter {
  insert(event: RedactedProvenanceEvent): ProvenanceRecordReceipt;
  insertIfAbsent(event: RedactedProvenanceEvent): ProvenanceReplayInsertResult;
}

export interface IProvenanceLedgerSchemaInspector {
  inspect(databasePath: string): ProvenanceLedgerSchemaInspection;
  assertCompatible(databasePath: string): ProvenanceLedgerSchemaInspection;
}

export interface IProvenanceJsonlReplayReader {
  read(jsonlDirectory: string): Promise<ValidatedProvenanceJsonlReplay>;
}

export interface IProvenanceLedgerRecoveryService {
  inspect(): ProvenanceLedgerSchemaInspection;
  recover(
    request: ProvenanceLedgerRecoveryRequest,
  ): Promise<ProvenanceLedgerRecoveryResult>;
}

export interface IProvenanceEmbeddingProvider {
  modelId(): string;
  embed(content: string[]): Promise<Float32Array[]>;
}

export interface IProvenanceIndexer {
  index(request: ProvenanceIndexRequest): Promise<ProvenanceIndexResult>;
}

export interface IProvenanceQueryService {
  listSessions(filter: ProvenanceQueryFilter): ProvenanceSessionSummary[];
  listEvents(filter: ProvenanceQueryFilter): PersistedProvenanceEvent[];
  listFailures(filter: ProvenanceQueryFilter, byAgent: boolean): unknown;
  summarizeAgents(filter: ProvenanceQueryFilter): ProvenanceAgentSummary[];
  search(query: ProvenanceSemanticQuery): Promise<ProvenanceSearchHit[]>;
  findSimilar(
    eventId: string,
    acrossWorkflows: boolean,
    limit: number,
  ): Promise<ProvenanceSearchHit[]>;
  findPatterns(query: ProvenancePatternQuery): Promise<ProvenancePatternResult>;
  exportEvents(
    filter: ProvenanceQueryFilter,
    format: "json" | "jsonl",
  ): string;
}

export declare function captureProvenanceEvent(
  harness: HarnessId,
  rawHookEvent: unknown,
): Promise<ProvenanceCaptureResult>;

export declare function buildProvenanceEmbeddingContent(
  event: RedactedProvenanceEvent,
): string;

export declare function runProvenanceCli(
  argv: string[],
  stdin: NodeJS.ReadableStream,
): Promise<number>;
