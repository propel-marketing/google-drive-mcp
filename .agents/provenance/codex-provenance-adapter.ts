import { randomUUID } from "node:crypto";

import type { IProvenanceHarnessAdapter } from "./provenance-contracts.js";
import {
  ClaudeCodeProvenanceEventNameSchema,
  CodexProvenanceEventNameSchema,
  CodexHookPayloadSchema,
  ValidatedProvenanceEventSchema,
  type HarnessId,
  type ProvenanceActorRole,
  type RawProvenanceHookEvent,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";

export type ProvenanceAdapterValidationCode =
  | "INVALID_HOOK_PAYLOAD"
  | "INVALID_RECORDED_AT"
  | "EVENT_NOT_ALLOWED"
  | "INVALID_VALIDATED_EVENT";

export class ProvenanceAdapterValidationError extends Error {
  readonly code: ProvenanceAdapterValidationCode;
  readonly harness: HarnessId;
  readonly eventName: string;

  constructor(
    code: ProvenanceAdapterValidationCode,
    harness: HarnessId,
    eventName: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvenanceAdapterValidationError";
    this.code = code;
    this.harness = harness;
    this.eventName = eventName;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventNameFrom(rawHookEvent: unknown): string {
  if (typeof rawHookEvent !== "object" || rawHookEvent === null) return "";
  return optionalString(
    (rawHookEvent as Record<string, unknown>).hook_event_name,
  ) ?? "";
}

function roleForSource(
  source: string,
  agentId: string | undefined,
): ProvenanceActorRole {
  const normalized = source.toLowerCase();
  if (normalized === "explore") return "explore";
  if (normalized === "plan") return "plan";
  if (agentId !== undefined || normalized !== "main") return "agent";
  return "orchestrator";
}

export function createValidatedProvenanceEvent(
  harness: HarnessId,
  rawHookEvent: RawProvenanceHookEvent,
  recordedAt: string,
): ValidatedProvenanceEvent {
  const eventName = rawHookEvent.hook_event_name;
  // Event vocabulary is schema-owned so importing a passive hook never reads
  // project configuration before the guarded capture boundary is running.
  const allowedEvents: readonly string[] = harness === "codex"
    ? CodexProvenanceEventNameSchema.options
    : ClaudeCodeProvenanceEventNameSchema.options;
  if (!allowedEvents.includes(eventName)) {
    throw new ProvenanceAdapterValidationError(
      "EVENT_NOT_ALLOWED",
      harness,
      eventName,
      `The ${harness} event is not present in the configured capture allowlist`,
    );
  }

  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new ProvenanceAdapterValidationError(
      "INVALID_RECORDED_AT",
      harness,
      eventName,
      "recordedAt is not a valid timestamp",
    );
  }

  const workflowId = optionalString(
    rawHookEvent.workflow_id ??
      rawHookEvent.workflowId ??
      rawHookEvent.plan_name ??
      rawHookEvent.planName,
  );
  const taskId = optionalString(rawHookEvent.task_id ?? rawHookEvent.taskId);
  const agentId = optionalString(rawHookEvent.agent_id);
  const agentType = optionalString(rawHookEvent.agent_type);
  const source = optionalString(rawHookEvent.source) ?? agentType ?? "main";

  const validated = ValidatedProvenanceEventSchema.safeParse({
    schemaVersion: 1,
    eventId: randomUUID(),
    recordedAt,
    harness,
    eventName,
    sessionId: rawHookEvent.session_id,
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(taskId === undefined ? {} : { taskId }),
    source,
    role: roleForSource(source, agentId),
    ...(agentId === undefined ? {} : { agentId }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(optionalString(rawHookEvent.tool_name) === undefined
      ? {}
      : { toolName: rawHookEvent.tool_name }),
    ...(optionalString(rawHookEvent.tool_use_id) === undefined
      ? {}
      : { toolUseId: rawHookEvent.tool_use_id }),
    ...(optionalString(rawHookEvent.transcript_path) === undefined
      ? {}
      : { transcriptPath: rawHookEvent.transcript_path }),
    cwd: rawHookEvent.cwd,
    eventData: rawHookEvent,
  });

  if (!validated.success) {
    throw new ProvenanceAdapterValidationError(
      "INVALID_VALIDATED_EVENT",
      harness,
      eventName,
      `Validated event failed at ${validated.error.issues
        .map((issue) => issue.path.join("."))
        .filter(Boolean)
        .join(", ") || "event"}`,
    );
  }
  return validated.data;
}

export class CodexProvenanceEventNormalizer
  implements IProvenanceHarnessAdapter
{
  normalize(
    rawHookEvent: unknown,
    recordedAt: string,
  ): ValidatedProvenanceEvent {
    const parsed = CodexHookPayloadSchema.safeParse(rawHookEvent);
    if (!parsed.success) {
      const eventName = eventNameFrom(rawHookEvent);
      throw new ProvenanceAdapterValidationError(
        "INVALID_HOOK_PAYLOAD",
        "codex",
        eventName,
        `Codex hook event failed at ${parsed.error.issues
          .map((issue) => issue.path.join("."))
          .filter(Boolean)
          .join(", ") || "event"}`,
      );
    }
    return createValidatedProvenanceEvent("codex", parsed.data, recordedAt);
  }
}

export { CodexProvenanceEventNormalizer as CodexProvenanceAdapter };
