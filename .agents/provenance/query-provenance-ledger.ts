import Database from "better-sqlite3";

import type {
  IProvenanceEmbeddingProvider,
  IProvenanceQueryService,
} from "./provenance-contracts.js";
import { ProvenanceLedgerSchemaInspector } from "./provenance-ledger-definition.js";
import {
  PersistedProvenanceEventRowSchema,
  PersistedProvenanceEventSchema,
  ProvenanceAgentSummarySchema,
  ProvenanceEmbeddingRowSchema,
  ProvenancePatternQuerySchema,
  ProvenancePatternResultSchema,
  ProvenanceQueryFilterSchema,
  ProvenanceSearchHitSchema,
  ProvenanceSemanticQuerySchema,
  ProvenanceSessionSummarySchema,
  RedactedProvenanceEventSchema,
  type PersistedProvenanceEvent,
  type PersistedProvenanceEventRow,
  type ProvenanceAgentSummary,
  type ProvenanceEmbeddingRow,
  type ProvenancePatternQuery,
  type ProvenancePatternResult,
  type ProvenanceQueryFilter,
  type ProvenanceSearchHit,
  type ProvenanceSemanticQuery,
  type ProvenanceSessionSummary,
} from "./provenance-schemas.js";
import { cosine } from "./embed-provenance-events.js";

type ReadOnlyProvenanceEmbeddingProvider = IProvenanceEmbeddingProvider & {
  embedReadOnly(content: string[]): Promise<Float32Array[]>;
};

export type ProvenanceEventQueryServiceOptions = {
  databasePath: string;
  embeddingProvider?: IProvenanceEmbeddingProvider;
};

export type ProvenanceFailureGroup = {
  agent: string;
  failureCount: number;
  toolCounts: Record<string, number>;
  failures: PersistedProvenanceEvent[];
};

type ProvenanceSessionSummaryRow = {
  harness: "codex" | "claude-code";
  session_id: string;
  workflow_id: string | null;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  failure_count: number;
};

type ProvenanceEmbeddingJoinRow = PersistedProvenanceEventRow & {
  embedding_event_id: string;
  model_id: string;
  dimensions: number;
  vector_blob: Buffer;
  document: string;
  indexed_at: string;
};

/** Read-only investigation surface over the local SQLite query mirror. */
export class ProvenanceEventQueryService implements IProvenanceQueryService {
  private readonly database: Database.Database;

  constructor(private readonly options: ProvenanceEventQueryServiceOptions) {
    new ProvenanceLedgerSchemaInspector().assertCompatible(options.databasePath);
    try {
      this.database = new Database(options.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      this.database.pragma("query_only = ON");
      this.database.pragma("busy_timeout = 5000");
    } catch {
      throw new Error(
        "Provenance ledger is unavailable. Run a captured session before querying.",
      );
    }
  }

  listSessions(filter: ProvenanceQueryFilter): ProvenanceSessionSummary[] {
    const parsed = ProvenanceQueryFilterSchema.parse(filter);
    const predicates: string[] = [];
    const parameters: unknown[] = [];
    appendEventPredicates(predicates, parameters, parsed);
    parameters.push(parsed.limit);

    const rows = this.database
      .prepare(
        `SELECT harness, session_id, workflow_id,
                MIN(recorded_at) AS started_at,
                MAX(CASE WHEN event_name IN ('Stop', 'SessionEnd')
                         THEN recorded_at END) AS ended_at,
                COUNT(*) AS event_count,
                SUM(CASE WHEN event_name = 'PostToolUseFailure' THEN 1 ELSE 0 END)
                  AS failure_count
         FROM provenance_events
         ${whereClause(predicates)}
         GROUP BY harness, session_id, workflow_id
         ORDER BY started_at ASC, harness ASC, session_id ASC
         LIMIT ?`,
      )
      .all(...parameters) as ProvenanceSessionSummaryRow[];

    return rows.map((row) =>
      ProvenanceSessionSummarySchema.parse({
        harness: row.harness,
        sessionId: row.session_id,
        ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        eventCount: row.event_count,
        failureCount: row.failure_count,
      }),
    );
  }

  listEvents(filter: ProvenanceQueryFilter): PersistedProvenanceEvent[] {
    const parsed = ProvenanceQueryFilterSchema.parse(filter);
    return this.queryEvents(parsed);
  }

  listFailures(
    filter: ProvenanceQueryFilter,
    byAgent = false,
  ): PersistedProvenanceEvent[] | ProvenanceFailureGroup[] {
    const parsed = ProvenanceQueryFilterSchema.parse(filter);
    const failures = this.queryEvents(parsed, ["event_name = 'PostToolUseFailure'"]);
    if (!byAgent) return failures;

    const groups = new Map<string, ProvenanceFailureGroup>();
    for (const failure of failures) {
      const agent = agentLabel(failure);
      const group = groups.get(agent) ?? {
        agent,
        failureCount: 0,
        toolCounts: {},
        failures: [],
      };
      group.failureCount += 1;
      group.failures.push(failure);
      const toolName = failure.toolName ?? "unknown";
      group.toolCounts[toolName] = (group.toolCounts[toolName] ?? 0) + 1;
      groups.set(agent, group);
    }
    return [...groups.values()].sort((left, right) =>
      left.agent.localeCompare(right.agent),
    );
  }

  summarizeAgents(filter: ProvenanceQueryFilter): ProvenanceAgentSummary[] {
    const events = this.queryEvents(ProvenanceQueryFilterSchema.parse(filter));
    const summaries = new Map<string, ProvenanceAgentSummary>();
    for (const event of events) {
      const agent = agentLabel(event);
      const key = [
        event.workflowId ?? "",
        agent,
        event.agentId ?? "",
        event.agentType ?? "",
      ].join("\u0000");
      const current = summaries.get(key);
      const toolNames = new Set(current?.toolNames ?? []);
      if (event.toolName !== undefined) toolNames.add(event.toolName);
      summaries.set(
        key,
        ProvenanceAgentSummarySchema.parse({
          ...(event.workflowId === undefined
            ? {}
            : { workflowId: event.workflowId }),
          agent,
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.agentType === undefined
            ? {}
            : { agentType: event.agentType }),
          eventCount: (current?.eventCount ?? 0) + 1,
          failureCount:
            (current?.failureCount ?? 0) +
            (event.eventName === "PostToolUseFailure" ? 1 : 0),
          toolNames: [...toolNames].sort(),
        }),
      );
    }
    return [...summaries.values()].sort(
      (left, right) =>
        (left.workflowId ?? "").localeCompare(right.workflowId ?? "") ||
        left.agent.localeCompare(right.agent),
    );
  }

  async search(query: ProvenanceSemanticQuery): Promise<ProvenanceSearchHit[]> {
    const parsed = ProvenanceSemanticQuerySchema.parse(query);
    const provider = this.requireEmbeddingProvider();
    const [queryVector] = await embedReadOnlyQuery(provider, parsed.text);
    if (queryVector === undefined || queryVector.length === 0) {
      throw new Error("Local semantic model did not return a query vector");
    }

    const predicates = ["m.model_id = ?"];
    const parameters: unknown[] = [provider.modelId()];
    if (parsed.eventName !== undefined) {
      predicates.push("e.event_name = ?");
      parameters.push(parsed.eventName);
    }
    const rows = this.embeddingRows(predicates, parameters);
    if (rows.length === 0) {
      throw new Error(
        "No matching semantic vectors are indexed. Run provenance index first.",
      );
    }
    return rankEmbeddingRows(rows, queryVector, parsed.limit);
  }

  async findSimilar(
    eventId: string,
    acrossWorkflows: boolean,
    limit: number,
  ): Promise<ProvenanceSearchHit[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Similar-event limit must be a positive integer");
    }

    const sourceRow = this.embeddingRows(
      ["e.event_id = ?"],
      [eventId],
    )[0];
    if (sourceRow === undefined) {
      throw new Error(
        "The source event has no semantic vector. Run provenance index first.",
      );
    }
    const sourceEvent = eventFromRow(sourceRow);
    const sourceEmbedding = embeddingFromJoinRow(sourceRow);
    const predicates = [
      "e.event_id != ?",
      "m.model_id = ?",
      "m.dimensions = ?",
    ];
    const parameters: unknown[] = [
      eventId,
      sourceEmbedding.modelId,
      sourceEmbedding.dimensions,
    ];
    if (!acrossWorkflows) {
      if (sourceEvent.workflowId === undefined) {
        predicates.push("e.workflow_id IS NULL");
      } else {
        predicates.push("e.workflow_id = ?");
        parameters.push(sourceEvent.workflowId);
      }
    }
    return rankEmbeddingRows(
      this.embeddingRows(predicates, parameters),
      vectorFromEmbedding(sourceEmbedding),
      limit,
    );
  }

  async findPatterns(query: ProvenancePatternQuery): Promise<ProvenancePatternResult> {
    const parsed = ProvenancePatternQuerySchema.parse(query);
    const filter = ProvenanceQueryFilterSchema.parse({
      ...(parsed.workflowId === undefined
        ? {}
        : { workflowId: parsed.workflowId }),
      limit: 10_000,
    });
    const failures = this.queryEvents(filter, ["event_name = 'PostToolUseFailure'"]);
    const failureIds = new Set(failures.map((failure) => failure.eventId));
    const embeddingRows = this.embeddingRows(
      [
        "e.event_name = 'PostToolUseFailure'",
        `e.event_id IN (${placeholders(failureIds.size)})`,
      ],
      [...failureIds],
    );

    const allFailureEmbeddingRows = this.embeddingRows(
      ["e.event_name = 'PostToolUseFailure'"],
      [],
    );
    const matches = [];
    const seen = new Set<string>();
    const semanticallyComparablePairs = new Set<string>();
    for (const sourceRow of embeddingRows) {
      const source = eventFromRow(sourceRow);
      if (source.workflowId === undefined) continue;
      const sourceEmbedding = embeddingFromJoinRow(sourceRow);
      for (const relatedRow of allFailureEmbeddingRows) {
        const related = eventFromRow(relatedRow);
        if (
          related.eventId === source.eventId ||
          related.workflowId === undefined ||
          related.workflowId === source.workflowId
        ) {
          continue;
        }
        const relatedEmbedding = embeddingFromJoinRow(relatedRow);
        if (
          relatedEmbedding.modelId !== sourceEmbedding.modelId ||
          relatedEmbedding.dimensions !== sourceEmbedding.dimensions
        ) {
          continue;
        }
        const pairKey = [source.eventId, related.eventId].sort().join("\u0000");
        semanticallyComparablePairs.add(pairKey);
        if (seen.has(pairKey)) continue;
        const score = cosine(
          vectorFromEmbedding(sourceEmbedding),
          vectorFromEmbedding(relatedEmbedding),
        );
        if (score < parsed.threshold) continue;
        seen.add(pairKey);
        matches.push({ failure: source, relatedFailure: related, score });
      }
    }

    const allFailures = this.allFailures();
    const usedStructuredFallback = failures.some((failure) =>
      allFailures.some((relatedFailure) => {
        if (
          failure.eventId === relatedFailure.eventId ||
          failure.workflowId === undefined ||
          relatedFailure.workflowId === undefined ||
          failure.workflowId === relatedFailure.workflowId
        ) {
          return false;
        }
        const pairKey = [failure.eventId, relatedFailure.eventId]
          .sort()
          .join("\u0000");
        return !semanticallyComparablePairs.has(pairKey);
      }),
    );
    const structuredMatches = structuredPatternMatches(
      failures,
      allFailures,
      Number.MAX_SAFE_INTEGER,
    ).filter((match) => {
      const pairKey = [match.failure.eventId, match.relatedFailure.eventId]
        .sort()
        .join("\u0000");
      if (semanticallyComparablePairs.has(pairKey) || seen.has(pairKey)) {
        return false;
      }
      seen.add(pairKey);
      return true;
    });
    matches.push(...structuredMatches);
    matches.sort(
      (left, right) =>
        right.score - left.score ||
        left.failure.sequence - right.failure.sequence ||
        left.relatedFailure.sequence - right.relatedFailure.sequence,
    );
    return ProvenancePatternResultSchema.parse({
      matches: matches.slice(0, parsed.limit),
      usedStructuredFallback,
    });
  }

  exportEvents(
    filter: ProvenanceQueryFilter,
    format: "json" | "jsonl",
  ): string {
    const events = this.listEvents(filter);
    if (format === "json") return JSON.stringify(events, null, 2);
    return events.length === 0
      ? ""
      : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  close(): void {
    this.database.close();
  }

  private queryEvents(
    filter: ProvenanceQueryFilter,
    extraPredicates: string[] = [],
  ): PersistedProvenanceEvent[] {
    const predicates = [...extraPredicates];
    const parameters: unknown[] = [];
    appendEventPredicates(predicates, parameters, filter);
    parameters.push(filter.limit);
    const rows = this.database
      .prepare(
        `SELECT * FROM provenance_events
         ${whereClause(predicates)}
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(...parameters) as PersistedProvenanceEventRow[];
    return rows.map(eventFromRow);
  }

  private embeddingRows(
    predicates: string[],
    parameters: unknown[],
  ): ProvenanceEmbeddingJoinRow[] {
    return this.database
      .prepare(
        `SELECT e.*,
                m.event_id AS embedding_event_id,
                m.model_id,
                m.dimensions,
                m.vector_blob,
                m.document,
                m.indexed_at
         FROM provenance_events e
         JOIN provenance_embeddings m ON m.event_id = e.event_id
         ${whereClause(predicates)}
         ORDER BY e.sequence ASC`,
      )
      .all(...parameters) as ProvenanceEmbeddingJoinRow[];
  }

  private allFailures(): PersistedProvenanceEvent[] {
    return this.queryEvents(
      ProvenanceQueryFilterSchema.parse({ limit: 10_000 }),
      ["event_name = 'PostToolUseFailure'"],
    );
  }

  private requireEmbeddingProvider(): IProvenanceEmbeddingProvider {
    if (this.options.embeddingProvider === undefined) {
      throw new Error(
        "Local semantic model support is unavailable. Install provenance dependencies and run provenance index first.",
      );
    }
    return this.options.embeddingProvider;
  }
}

export { ProvenanceEventQueryService as ProvenanceQueryService };

function embedReadOnlyQuery(
  provider: IProvenanceEmbeddingProvider,
  content: string,
): Promise<Float32Array[]> {
  if (isReadOnlyEmbeddingProvider(provider)) {
    return provider.embedReadOnly([content]);
  }
  return provider.embed([content]);
}

function isReadOnlyEmbeddingProvider(
  provider: IProvenanceEmbeddingProvider,
): provider is ReadOnlyProvenanceEmbeddingProvider {
  return (
    "embedReadOnly" in provider &&
    typeof (provider as Partial<ReadOnlyProvenanceEmbeddingProvider>)
      .embedReadOnly === "function"
  );
}

function appendEventPredicates(
  predicates: string[],
  parameters: unknown[],
  filter: ProvenanceQueryFilter,
): void {
  addPredicate(predicates, parameters, "harness", filter.harness);
  addPredicate(predicates, parameters, "session_id", filter.sessionId);
  addPredicate(predicates, parameters, "workflow_id", filter.workflowId);
  addPredicate(predicates, parameters, "event_name", filter.eventName);
  addPredicate(predicates, parameters, "tool_name", filter.toolName);
  if (filter.agent !== undefined) {
    predicates.push("(source = ? OR agent_id = ? OR agent_type = ?)");
    parameters.push(filter.agent, filter.agent, filter.agent);
  }
  addRangePredicate(predicates, parameters, "recorded_at", ">=", filter.from);
  addRangePredicate(predicates, parameters, "recorded_at", "<=", filter.to);
}

function eventFromRow(row: PersistedProvenanceEventRow): PersistedProvenanceEvent {
  const parsedRow = PersistedProvenanceEventRowSchema.parse(row);
  const redactedEvent = RedactedProvenanceEventSchema.parse(
    JSON.parse(parsedRow.redacted_event_json) as unknown,
  );
  return PersistedProvenanceEventSchema.parse({
    ...redactedEvent,
    sequence: parsedRow.sequence,
    vectorized: parsedRow.vectorized === 1,
  });
}

function embeddingFromJoinRow(row: ProvenanceEmbeddingJoinRow): ProvenanceEmbeddingRow {
  return ProvenanceEmbeddingRowSchema.parse({
    eventId: row.embedding_event_id,
    modelId: row.model_id,
    dimensions: row.dimensions,
    vectorBlob: row.vector_blob,
    document: row.document,
    indexedAt: row.indexed_at,
  });
}

function rankEmbeddingRows(
  rows: ProvenanceEmbeddingJoinRow[],
  queryVector: Float32Array,
  limit: number,
): ProvenanceSearchHit[] {
  return rows
    .map((row) => {
      const embedding = embeddingFromJoinRow(row);
      return ProvenanceSearchHitSchema.parse({
        event: eventFromRow(row),
        score: cosine(queryVector, vectorFromEmbedding(embedding)),
        modelId: embedding.modelId,
        document: embedding.document,
      });
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.event.sequence - right.event.sequence,
    )
    .slice(0, limit);
}

function vectorFromEmbedding(embedding: ProvenanceEmbeddingRow): Float32Array {
  if (embedding.vectorBlob.byteLength !== embedding.dimensions * 4) {
    throw new Error("Stored semantic vector has invalid dimensions");
  }
  const ownedBytes = Uint8Array.from(embedding.vectorBlob);
  return new Float32Array(ownedBytes.buffer);
}

function structuredPatternMatches(
  sourceFailures: PersistedProvenanceEvent[],
  allFailures: PersistedProvenanceEvent[],
  limit: number,
) {
  const matches = [];
  const seen = new Set<string>();
  for (const source of sourceFailures) {
    if (source.workflowId === undefined) continue;
    const sourceSignature = failureSignature(source);
    for (const related of allFailures) {
      if (
        related.eventId === source.eventId ||
        related.workflowId === undefined ||
        related.workflowId === source.workflowId ||
        failureSignature(related) !== sourceSignature
      ) {
        continue;
      }
      const pairKey = [source.eventId, related.eventId].sort().join("\u0000");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      matches.push({ failure: source, relatedFailure: related, score: 1 });
      if (matches.length === limit) return matches;
    }
  }
  return matches;
}

function failureSignature(event: PersistedProvenanceEvent): string {
  const eventData = isRecord(event.eventData) ? event.eventData : {};
  const detail = eventData.error ?? eventData.tool_response ?? event.eventData;
  return `${event.toolName ?? "unknown"}\u0000${stableJson(detail)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function agentLabel(event: PersistedProvenanceEvent): string {
  return event.source || event.agentType || event.agentId || "unknown";
}

function addPredicate(
  predicates: string[],
  parameters: unknown[],
  column: string,
  value: unknown,
): void {
  if (value === undefined) return;
  predicates.push(`${column} = ?`);
  parameters.push(value);
}

function addRangePredicate(
  predicates: string[],
  parameters: unknown[],
  column: string,
  operator: ">=" | "<=",
  value: unknown,
): void {
  if (value === undefined) return;
  predicates.push(`${column} ${operator} ?`);
  parameters.push(value);
}

function placeholders(count: number): string {
  return count === 0 ? "NULL" : Array.from({ length: count }, () => "?").join(", ");
}

function whereClause(predicates: string[]): string {
  return predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
