import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import type {
  IProvenanceEmbeddingProvider,
  IProvenanceIndexer,
} from "./provenance-contracts.js";
import { ProvenanceLedgerSchemaInspector } from "./provenance-ledger-definition.js";
import {
  ProvenanceIndexRequestSchema,
  ProvenanceIndexResultSchema,
  RedactedProvenanceEventSchema,
  type ProvenanceIndexRequest,
  type ProvenanceIndexResult,
  type RedactedProvenanceEvent,
} from "./provenance-schemas.js";

const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type LocalFeatureExtractorResult = {
  dims: readonly number[];
  data: ArrayLike<number>;
};

type LocalFeatureExtractor = (
  content: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<LocalFeatureExtractorResult>;

type ProvenanceIndexEventRow = {
  event_id: string;
  redacted_event_json: string;
};

export type ProvenanceEventIndexerOptions = {
  databasePath: string;
  embeddingProvider: IProvenanceEmbeddingProvider;
  now?: () => string;
};

/**
 * Loads the optional local MiniLM runtime only when an explicit index command
 * needs vectors. Merely constructing this provider has no filesystem effect.
 */
export class LocalProvenanceEmbeddingProvider
  implements IProvenanceEmbeddingProvider
{
  private initializingExtractorPromise: Promise<LocalFeatureExtractor> | undefined;
  private readOnlyExtractorPromise: Promise<LocalFeatureExtractor> | undefined;

  constructor(
    private readonly modelCacheDirectory: string,
    private readonly embeddingModelId = DEFAULT_EMBEDDING_MODEL,
    private readonly extractorFactory?: () => Promise<LocalFeatureExtractor>,
  ) {}

  modelId(): string {
    return this.embeddingModelId;
  }

  async embed(content: string[]): Promise<Float32Array[]> {
    return this.embedWithMode(content, "initialize");
  }

  /**
   * Embeds a query using only model artifacts already present in the configured
   * cache. Unlike explicit indexing, this path never creates the cache and
   * disables remote model loading before constructing the pipeline.
   */
  async embedReadOnly(content: string[]): Promise<Float32Array[]> {
    return this.embedWithMode(content, "read-only");
  }

  private async embedWithMode(
    content: string[],
    mode: "initialize" | "read-only",
  ): Promise<Float32Array[]> {
    if (content.length === 0) return [];
    if (content.some((entry) => entry.trim().length === 0)) {
      throw new Error("Semantic index documents must not be empty");
    }

    const extractor = await this.extractor(mode);
    const tensor = await extractor(content, { pooling: "mean", normalize: true });
    const dimensions = tensor.dims.at(-1);
    if (
      dimensions === undefined ||
      dimensions < 1 ||
      tensor.data.length !== dimensions * content.length
    ) {
      throw new Error("Local semantic model returned an unexpected tensor shape");
    }

    const vectors: Float32Array[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const start = index * dimensions;
      const vector = new Float32Array(dimensions);
      for (let offset = 0; offset < dimensions; offset += 1) {
        vector[offset] = Number(tensor.data[start + offset]);
      }
      vectors.push(normalizeVector(vector));
    }
    return vectors;
  }

  private async extractor(
    mode: "initialize" | "read-only",
  ): Promise<LocalFeatureExtractor> {
    const currentPromise =
      mode === "initialize"
        ? this.initializingExtractorPromise
        : this.readOnlyExtractorPromise;
    if (currentPromise === undefined) {
      const initialization = this.createExtractor(mode);
      if (mode === "initialize") {
        this.initializingExtractorPromise = initialization;
      } else {
        this.readOnlyExtractorPromise = initialization;
      }
      try {
        return await initialization;
      } catch (error) {
        if (
          mode === "initialize" &&
          this.initializingExtractorPromise === initialization
        ) {
          this.initializingExtractorPromise = undefined;
        }
        if (
          mode === "read-only" &&
          this.readOnlyExtractorPromise === initialization
        ) {
          this.readOnlyExtractorPromise = undefined;
        }
        throw error;
      }
    }
    return currentPromise;
  }

  private async createExtractor(
    mode: "initialize" | "read-only",
  ): Promise<LocalFeatureExtractor> {
    if (this.extractorFactory !== undefined) {
      return this.extractorFactory();
    }

    const cacheDirectory = resolve(this.modelCacheDirectory);
    if (mode === "read-only") {
      try {
        if (!(await stat(cacheDirectory)).isDirectory()) throw new Error();
      } catch {
        throw new Error(
          "Local semantic model cache is unavailable. Run provenance index first.",
        );
      }
    }

    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch {
      throw new Error(
        "Local semantic model support is unavailable. Run npm install in .agents/provenance, then run provenance index again.",
      );
    }

    if (mode === "initialize") {
      await mkdir(cacheDirectory, { recursive: true });
    }
    transformers.env.cacheDir = cacheDirectory;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = mode === "initialize";
    try {
      return (await transformers.pipeline(
        "feature-extraction",
        this.embeddingModelId,
      )) as unknown as LocalFeatureExtractor;
    } catch {
      throw new Error(
        mode === "read-only"
          ? "Local semantic model cache is unavailable or incomplete. Run provenance index first."
          : `Local semantic model '${this.embeddingModelId}' could not be loaded. Confirm network access for the first download, then run provenance index again.`,
      );
    }
  }
}

/**
 * Builds an all-event redacted document. Event-specific high-value fields are
 * promoted first and the bounded redacted event body preserves useful context
 * for lifecycle categories that have no special representation.
 */
export function buildProvenanceEmbeddingContent(
  provenanceEvent: RedactedProvenanceEvent,
): string {
  const event = RedactedProvenanceEventSchema.parse(provenanceEvent);
  const eventData = isRecord(event.eventData) ? event.eventData : {};
  const parts = [
    `event: ${event.eventName}`,
    `harness: ${event.harness}`,
    `source: ${event.source}`,
    `role: ${event.role}`,
  ];

  addText(parts, "workflow", event.workflowId);
  addText(parts, "task", event.taskId);
  addText(parts, "agent", event.agentType ?? event.agentId);
  addText(parts, "tool", event.toolName);

  switch (event.eventName) {
    case "UserPromptSubmit":
      addText(parts, "prompt", eventData.prompt);
      break;
    case "PreToolUse":
      addJson(parts, "input", eventData.tool_input);
      break;
    case "PostToolUse":
      addJson(parts, "input", eventData.tool_input);
      addJson(parts, "response", eventData.tool_response);
      addJson(parts, "error", eventData.error);
      break;
    case "PostToolUseFailure":
      addJson(parts, "input", eventData.tool_input);
      addJson(parts, "failure", eventData.error ?? eventData.tool_response);
      break;
    case "SubagentStart":
      addText(parts, "agent-start", event.agentType ?? event.agentId);
      addText(parts, "instructions", eventData.custom_instructions);
      break;
    case "SubagentStop":
      addText(parts, "agent-stop", event.agentType ?? event.agentId);
      addText(parts, "summary", eventData.last_assistant_message);
      addJson(parts, "result", eventData.tool_response);
      break;
    case "Stop":
    case "SessionEnd":
      addText(parts, "summary", eventData.last_assistant_message);
      addText(parts, "reason", eventData.reason);
      break;
    case "PreCompact":
    case "PostCompact":
      addText(parts, "trigger", eventData.trigger);
      addText(parts, "instructions", eventData.custom_instructions);
      break;
    case "SessionStart":
      addText(parts, "model", eventData.model);
      addText(parts, "session-source", eventData.source);
      break;
    case "PermissionRequest":
      addJson(parts, "permission", eventData);
      break;
  }

  addJson(parts, "event-data", event.eventData);
  return parts.join("\n");
}

export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : Math.max(-1, Math.min(1, dot / denominator));
}

/** Explicit, incremental owner of all semantic index mutations. */
export class ProvenanceEventIndexer implements IProvenanceIndexer {
  private readonly now: () => string;

  constructor(private readonly options: ProvenanceEventIndexerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async index(request: ProvenanceIndexRequest): Promise<ProvenanceIndexResult> {
    const parsed = ProvenanceIndexRequestSchema.parse(request);
    new ProvenanceLedgerSchemaInspector().assertCompatible(
      this.options.databasePath,
    );
    if (parsed.dryRun) {
      const database = openExistingLedger(this.options.databasePath, true);
      try {
        return ProvenanceIndexResultSchema.parse({
          dryRun: true,
          eligibleCount: countPendingEvents(database),
          indexedCount: 0,
          failedCount: 0,
        });
      } finally {
        database.close();
      }
    }

    const database = openExistingLedger(this.options.databasePath, false);
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    const eligibleCount = countPendingEvents(database);
    let indexedCount = 0;
    try {
      while (true) {
        const rows = database
          .prepare(
            `SELECT event_id, redacted_event_json
             FROM provenance_events
             WHERE vectorized = 0
             ORDER BY sequence ASC
             LIMIT ?`,
          )
          .all(parsed.batchSize) as ProvenanceIndexEventRow[];
        if (rows.length === 0) break;

        const documents = rows.map((row) =>
          buildProvenanceEmbeddingContent(
            RedactedProvenanceEventSchema.parse(
              JSON.parse(row.redacted_event_json) as unknown,
            ),
          ),
        );
        const vectors = await this.options.embeddingProvider.embed(documents);
        if (vectors.length !== rows.length) {
          throw new Error("Local semantic model returned an incomplete batch");
        }

        const indexedAt = this.now();
        const modelId = this.options.embeddingProvider.modelId();
        const persistBatch = database.transaction(() => {
          const insert = database.prepare(
            `INSERT INTO provenance_embeddings (
               event_id, model_id, dimensions, vector_blob, document, indexed_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(event_id) DO UPDATE SET
               model_id = excluded.model_id,
               dimensions = excluded.dimensions,
               vector_blob = excluded.vector_blob,
               document = excluded.document,
               indexed_at = excluded.indexed_at`,
          );
          const flag = database.prepare(
            "UPDATE provenance_events SET vectorized = 1 WHERE event_id = ?",
          );
          rows.forEach((row, index) => {
            const vector = vectors[index];
            if (vector === undefined || vector.length === 0) {
              throw new Error("Local semantic model returned an empty vector");
            }
            const normalized = normalizeVector(vector);
            insert.run(
              row.event_id,
              modelId,
              normalized.length,
              vectorBuffer(normalized),
              documents[index],
              indexedAt,
            );
            flag.run(row.event_id);
          });
        });
        persistBatch();
        indexedCount += rows.length;
      }

      return ProvenanceIndexResultSchema.parse({
        dryRun: false,
        eligibleCount,
        indexedCount,
        failedCount: 0,
        modelId: this.options.embeddingProvider.modelId(),
      });
    } finally {
      database.close();
    }
  }
}

export { ProvenanceEventIndexer as ProvenanceIndexer };

function openExistingLedger(
  databasePath: string,
  readonly: boolean,
): Database.Database {
  try {
    const database = new Database(databasePath, {
      readonly,
      fileMustExist: true,
    });
    if (readonly) database.pragma("query_only = ON");
    return database;
  } catch {
    throw new Error(
      "Provenance ledger is unavailable. Run a captured session before querying or indexing.",
    );
  }
}

function countPendingEvents(database: Database.Database): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM provenance_events WHERE vectorized = 0")
    .get() as { count: number };
  return row.count;
}

function vectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function normalizeVector(vector: Float32Array): Float32Array {
  let squaredMagnitude = 0;
  for (const value of vector) squaredMagnitude += value * value;
  const magnitude = Math.sqrt(squaredMagnitude);
  if (magnitude === 0) return Float32Array.from(vector);
  return Float32Array.from(vector, (value) => value / magnitude);
}

function addText(parts: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    parts.push(`${label}: ${value.trim()}`);
  }
}

function addJson(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length > 0 && serialized !== "{}" && serialized !== "[]") {
    parts.push(`${label}: ${serialized}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
