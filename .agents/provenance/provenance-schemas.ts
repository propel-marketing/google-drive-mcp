import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DateTimeSchema = z.string().datetime({ offset: true });
const ProjectRelativePathSchema = z.string().min(1).refine(
  (path) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path),
  "Expected a project-relative path",
);

export const HarnessIdSchema = z.enum(["codex", "claude-code"]);

export const ClaudeCodeProvenanceEventNameSchema = z.enum([
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
]);

export const CodexProvenanceEventNameSchema = z.enum([
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
]);

export const ProvenanceEventNameSchema = z.union([
  ClaudeCodeProvenanceEventNameSchema,
  CodexProvenanceEventNameSchema,
]);

export const NullableOptionalHookStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

export const ProvenanceHookRejectionIdentitySchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: ProvenanceEventNameSchema,
  transcript_path: NullableOptionalHookStringSchema,
});

export const ProvenanceHookRejectionMarkerSchema = z.object({
  markerType: z.literal("hook-validation-rejection"),
  captureStatus: z.literal("unrecorded"),
  stage: z.literal("normalize"),
  errorName: z.string().min(1).max(128),
  errorCode: z.string().min(1).max(128).optional(),
  sanitizedMessage: z.string().min(1).max(1_024),
  remediation: z.string().min(1).max(512).optional(),
});

export const RawProvenanceHookEventSchema = z
  .object({
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    hook_event_name: z.string().min(1),
    transcript_path: NullableOptionalHookStringSchema,
    source: NullableOptionalHookStringSchema,
    model: NullableOptionalHookStringSchema,
    permission_mode: NullableOptionalHookStringSchema,
    prompt: NullableOptionalHookStringSchema,
    tool_name: NullableOptionalHookStringSchema,
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    error: z.unknown().optional(),
    is_interrupt: z.boolean().optional(),
    last_assistant_message: NullableOptionalHookStringSchema,
    agent_id: NullableOptionalHookStringSchema,
    agent_type: NullableOptionalHookStringSchema,
    agent_transcript_path: NullableOptionalHookStringSchema,
    turn_id: NullableOptionalHookStringSchema,
    tool_use_id: NullableOptionalHookStringSchema,
    trigger: NullableOptionalHookStringSchema,
    custom_instructions: NullableOptionalHookStringSchema,
    reason: NullableOptionalHookStringSchema,
    timestamp: z.preprocess(
      (value) => (value === null ? undefined : value),
      DateTimeSchema.optional(),
    ),
  })
  .passthrough();

// Harness-specific aliases deliberately share one forward-compatible raw boundary.
export const CodexHookPayloadSchema = RawProvenanceHookEventSchema;
export const ClaudeCodeHookPayloadSchema = RawProvenanceHookEventSchema;

export const ProvenanceActorRoleSchema = z.enum([
  "orchestrator",
  "agent",
  "explore",
  "plan",
  "unknown",
]);

export const ValidatedProvenanceEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  recordedAt: DateTimeSchema,
  harness: HarnessIdSchema,
  eventName: ProvenanceEventNameSchema,
  sessionId: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  source: z.string().min(1),
  role: ProvenanceActorRoleSchema,
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  toolUseId: z.string().min(1).optional(),
  transcriptPath: z.string().optional(),
  cwd: z.string().min(1),
  eventData: z.unknown(),
});

export const ProvenanceActorContextSchema = z.object({
  workflowId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  source: z.string().min(1),
  role: ProvenanceActorRoleSchema,
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
});

export const ProvenanceTruncatedFieldSchema = z.object({
  path: z.string().min(1),
  originalBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});

export const RedactedProvenanceEventSchema =
  ValidatedProvenanceEventSchema.omit({
    cwd: true,
    transcriptPath: true,
    eventData: true,
  }).extend({
    cwd: z.string().min(1),
    transcriptPath: z.string().optional(),
    eventData: z.unknown(),
    redactionCount: z.number().int().nonnegative(),
    truncatedFields: z.array(ProvenanceTruncatedFieldSchema),
    contentSha256: Sha256Schema,
  });

export const PersistedProvenanceEventSchema = RedactedProvenanceEventSchema.extend({
  sequence: z.number().int().positive(),
  vectorized: z.boolean(),
});

export const ProvenanceCaptureDiagnosticSchema = z.object({
  stage: z.enum([
    "input",
    "normalize",
    "actor",
    "redact",
    "jsonl",
    "sqlite",
    "terminal",
  ]),
  errorName: z.string().min(1).max(128).optional(),
  errorCode: z.string().min(1).max(128).optional(),
  sanitizedMessage: z.string().min(1).max(1_024),
  remediation: z.string().min(1).max(512).optional(),
});

export const ProvenanceRecordReceiptSchema = z.object({
  sequence: z.number().int().positive(),
  eventId: z.string().uuid(),
  sessionId: z.string().min(1),
});

export const ProvenanceRejectionMarkerOutcomeSchema = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string().min(1),
  status: z.enum(["recorded", "degraded", "unrecorded"]),
  receipt: ProvenanceRecordReceiptSchema.optional(),
  integrityWarning: z.string().min(1).max(1_024).optional(),
});

export const ProvenanceCaptureResultSchema = z.object({
  status: z.enum(["recorded", "degraded", "unrecorded"]),
  eventId: z.string().min(1),
  receipt: ProvenanceRecordReceiptSchema.optional(),
  diagnostics: z.array(ProvenanceCaptureDiagnosticSchema).default([]),
  integrityWarning: z.string().min(1).max(1_024).optional(),
  rejectionMarkerOutcome: ProvenanceRejectionMarkerOutcomeSchema.optional(),
});

export const ProvenanceCaptureConfigSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  neverControlsWorkflow: z.literal(true),
  maxFieldBytes: z.number().int().positive(),
  paths: z.object({
    ledger: ProjectRelativePathSchema,
    jsonlDirectory: ProjectRelativePathSchema,
    actorStateDirectory: ProjectRelativePathSchema,
    modelCacheDirectory: ProjectRelativePathSchema,
  }),
  jsonl: z.object({
    lockRetryCount: z.number().int().nonnegative(),
    lockRetryDelayMs: z.number().int().nonnegative(),
    staleLockMs: z.number().int().positive(),
  }),
  embeddings: z.object({
    modelId: z.string().min(1),
    pooling: z.literal("mean"),
    normalize: z.literal(true),
    runInsideCaptureHook: z.literal(false),
  }),
  captureEvents: z.object({
    codex: z.tuple([
      z.literal("SessionStart"),
      z.literal("UserPromptSubmit"),
      z.literal("PreToolUse"),
      z.literal("PermissionRequest"),
      z.literal("PostToolUse"),
      z.literal("PreCompact"),
      z.literal("PostCompact"),
      z.literal("SubagentStart"),
      z.literal("SubagentStop"),
      z.literal("Stop"),
    ]),
    "claude-code": z.tuple([
      z.literal("SessionStart"),
      z.literal("UserPromptSubmit"),
      z.literal("PreToolUse"),
      z.literal("PostToolUse"),
      z.literal("PostToolUseFailure"),
      z.literal("SubagentStart"),
      z.literal("SubagentStop"),
      z.literal("Stop"),
      z.literal("PreCompact"),
      z.literal("PostCompact"),
      z.literal("SessionEnd"),
    ]),
  }),
});

export const ActivePlanRegistrySchema = z.record(
  z.string().min(1),
  z
    .object({
      planRoot: z.string().min(1),
      status: z.enum(["active", "completed"]).optional(),
      taskId: z.string().optional(),
    })
    .passthrough(),
);

export const ProvenanceQueryFilterSchema = z.object({
  harness: HarnessIdSchema.optional(),
  sessionId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  eventName: ProvenanceEventNameSchema.optional(),
  toolName: z.string().min(1).optional(),
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  limit: z.number().int().positive().default(100),
});

export const ProvenanceIndexRequestSchema = z.object({
  batchSize: z.number().int().positive().default(500),
  dryRun: z.boolean().default(false),
});

export const ProvenanceIndexResultSchema = z.object({
  dryRun: z.boolean(),
  eligibleCount: z.number().int().nonnegative(),
  indexedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  modelId: z.string().min(1).optional(),
});

export const ProvenanceSemanticQuerySchema = z.object({
  text: z.string().min(1),
  eventName: ProvenanceEventNameSchema.optional(),
  limit: z.number().int().positive().default(10),
});

export const ProvenancePatternQuerySchema = z.object({
  workflowId: z.string().min(1).optional(),
  limit: z.number().int().positive().default(10),
  threshold: z.number().min(0).max(1).default(0.5),
});

export const ProvenanceSearchHitSchema = z.object({
  event: PersistedProvenanceEventSchema,
  score: z.number().min(-1).max(1),
  modelId: z.string().min(1),
  document: z.string(),
});

export const ProvenancePatternMatchSchema = z.object({
  failure: PersistedProvenanceEventSchema,
  relatedFailure: PersistedProvenanceEventSchema,
  score: z.number().min(-1).max(1),
});

export const ProvenancePatternResultSchema = z.object({
  matches: z.array(ProvenancePatternMatchSchema),
  usedStructuredFallback: z.boolean(),
});

export const ProvenanceAgentSummarySchema = z.object({
  workflowId: z.string().min(1).optional(),
  agent: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  eventCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  toolNames: z.array(z.string().min(1)),
});

export const ProvenanceSessionSummarySchema = z.object({
  harness: HarnessIdSchema,
  sessionId: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  startedAt: DateTimeSchema,
  endedAt: DateTimeSchema.optional(),
  eventCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
});

export const PersistedProvenanceEventRowSchema = z.object({
  sequence: z.number().int().positive(),
  event_id: z.string().uuid(),
  schema_version: z.literal(1),
  recorded_at: DateTimeSchema,
  harness: HarnessIdSchema,
  session_id: z.string().min(1),
  workflow_id: z.string().nullable(),
  task_id: z.string().nullable(),
  event_name: ProvenanceEventNameSchema,
  source: z.string().min(1),
  role: ProvenanceActorRoleSchema,
  agent_id: z.string().nullable(),
  agent_type: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  cwd: z.string().min(1),
  transcript_path: z.string().nullable(),
  redacted_event_json: z.string(),
  content_sha256: Sha256Schema,
  vectorized: z.union([z.literal(0), z.literal(1)]),
});

export const ProvenanceEmbeddingRowSchema = z.object({
  eventId: z.string().uuid(),
  modelId: z.string().min(1),
  dimensions: z.number().int().positive(),
  vectorBlob: z.instanceof(Buffer),
  document: z.string(),
  indexedAt: DateTimeSchema,
});

// Transitional aliases keep unchanged phase-owned files importable while the
// later tasks replace their full-audit implementations.
export const NormalizedProvenanceEventSchema = ValidatedProvenanceEventSchema;
export const ProvenanceExecutionContextSchema = ProvenanceActorContextSchema;
export const ProvenanceSessionFilterSchema = ProvenanceQueryFilterSchema;
export const ProvenanceEventFilterSchema = ProvenanceQueryFilterSchema;
export const ProvenanceSessionSchema = ProvenanceSessionSummarySchema;
export const ProvenanceEmbeddingSchema = z.object({
  eventId: z.string().uuid(),
  modelId: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.instanceof(Float32Array),
  contentSha256: Sha256Schema,
  embeddedAt: DateTimeSchema,
});

export type HarnessId = z.infer<typeof HarnessIdSchema>;
export type ClaudeCodeProvenanceEventName = z.infer<
  typeof ClaudeCodeProvenanceEventNameSchema
>;
export type CodexProvenanceEventName = z.infer<
  typeof CodexProvenanceEventNameSchema
>;
export type ProvenanceEventName = z.infer<typeof ProvenanceEventNameSchema>;
export type ProvenanceHookRejectionIdentity = z.infer<
  typeof ProvenanceHookRejectionIdentitySchema
>;
export type ProvenanceHookRejectionMarker = z.infer<
  typeof ProvenanceHookRejectionMarkerSchema
>;
export type RawProvenanceHookEvent = z.infer<
  typeof RawProvenanceHookEventSchema
>;
export type CodexHookPayload = z.infer<typeof CodexHookPayloadSchema>;
export type ClaudeCodeHookPayload = z.infer<typeof ClaudeCodeHookPayloadSchema>;
export type ProvenanceActorRole = z.infer<typeof ProvenanceActorRoleSchema>;
export type ValidatedProvenanceEvent = z.infer<
  typeof ValidatedProvenanceEventSchema
>;
export type ProvenanceActorContext = z.infer<
  typeof ProvenanceActorContextSchema
>;
export type ProvenanceTruncatedField = z.infer<
  typeof ProvenanceTruncatedFieldSchema
>;
export type RedactedProvenanceEvent = z.infer<
  typeof RedactedProvenanceEventSchema
>;
export type PersistedProvenanceEvent = z.infer<
  typeof PersistedProvenanceEventSchema
>;
export type ProvenanceCaptureDiagnostic = z.infer<
  typeof ProvenanceCaptureDiagnosticSchema
>;
export type ProvenanceRecordReceipt = z.infer<
  typeof ProvenanceRecordReceiptSchema
>;
export type ProvenanceRejectionMarkerOutcome = z.infer<
  typeof ProvenanceRejectionMarkerOutcomeSchema
>;
export type ProvenanceCaptureResult = z.infer<
  typeof ProvenanceCaptureResultSchema
>;
export type ProvenanceCaptureConfig = z.infer<
  typeof ProvenanceCaptureConfigSchema
>;
export type ActivePlanRegistry = z.infer<typeof ActivePlanRegistrySchema>;
export type ProvenanceQueryFilter = z.infer<
  typeof ProvenanceQueryFilterSchema
>;
export type ProvenanceIndexRequest = z.infer<
  typeof ProvenanceIndexRequestSchema
>;
export type ProvenanceIndexResult = z.infer<typeof ProvenanceIndexResultSchema>;
export type ProvenanceSemanticQuery = z.infer<
  typeof ProvenanceSemanticQuerySchema
>;
export type ProvenancePatternQuery = z.infer<
  typeof ProvenancePatternQuerySchema
>;
export type ProvenanceSearchHit = z.infer<typeof ProvenanceSearchHitSchema>;
export type ProvenancePatternMatch = z.infer<
  typeof ProvenancePatternMatchSchema
>;
export type ProvenancePatternResult = z.infer<
  typeof ProvenancePatternResultSchema
>;
export type ProvenanceAgentSummary = z.infer<
  typeof ProvenanceAgentSummarySchema
>;
export type ProvenanceSessionSummary = z.infer<
  typeof ProvenanceSessionSummarySchema
>;
export type PersistedProvenanceEventRow = z.infer<
  typeof PersistedProvenanceEventRowSchema
>;
export type ProvenanceEmbeddingRow = z.infer<
  typeof ProvenanceEmbeddingRowSchema
>;

export type NormalizedProvenanceEvent = z.infer<
  typeof NormalizedProvenanceEventSchema
>;
export type ProvenanceExecutionContext = z.infer<
  typeof ProvenanceExecutionContextSchema
>;
export type ProvenanceSessionFilter = z.infer<
  typeof ProvenanceSessionFilterSchema
>;
export type ProvenanceEventFilter = z.infer<
  typeof ProvenanceEventFilterSchema
>;
export type ProvenanceSession = z.infer<typeof ProvenanceSessionSchema>;
export type ProvenanceEmbedding = z.infer<typeof ProvenanceEmbeddingSchema>;
