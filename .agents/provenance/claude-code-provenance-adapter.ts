import type { IProvenanceHarnessAdapter } from "./provenance-contracts.js";
import {
  ClaudeCodeHookPayloadSchema,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";
import {
  createValidatedProvenanceEvent,
  ProvenanceAdapterValidationError,
} from "./codex-provenance-adapter.js";

function eventNameFrom(rawHookEvent: unknown): string {
  if (typeof rawHookEvent !== "object" || rawHookEvent === null) return "";
  const eventName = (rawHookEvent as Record<string, unknown>).hook_event_name;
  return typeof eventName === "string" ? eventName : "";
}

export class ClaudeCodeProvenanceEventNormalizer
  implements IProvenanceHarnessAdapter
{
  normalize(
    rawHookEvent: unknown,
    recordedAt: string,
  ): ValidatedProvenanceEvent {
    const parsed = ClaudeCodeHookPayloadSchema.safeParse(rawHookEvent);
    if (!parsed.success) {
      throw new ProvenanceAdapterValidationError(
        "INVALID_HOOK_PAYLOAD",
        "claude-code",
        eventNameFrom(rawHookEvent),
        `Claude Code hook event failed at ${parsed.error.issues
          .map((issue) => issue.path.join("."))
          .filter(Boolean)
          .join(", ") || "event"}`,
      );
    }
    return createValidatedProvenanceEvent(
      "claude-code",
      parsed.data,
      recordedAt,
    );
  }
}

export { ClaudeCodeProvenanceEventNormalizer as ClaudeCodeProvenanceAdapter };
