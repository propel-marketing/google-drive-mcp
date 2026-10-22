import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeCodeProvenanceAdapter } from "./claude-code-provenance-adapter.js";
import { CodexProvenanceAdapter } from "./codex-provenance-adapter.js";
import { ProvenanceJsonlMirror } from "./mirror-provenance-jsonl.js";
import type { IProvenanceHarnessAdapter } from "./provenance-contracts.js";
import {
  ClaudeCodeProvenanceEventNameSchema,
  CodexProvenanceEventNameSchema,
  HarnessIdSchema,
  ProvenanceActorContextSchema,
  ProvenanceCaptureConfigSchema,
  ProvenanceCaptureDiagnosticSchema,
  ProvenanceCaptureResultSchema,
  ProvenanceHookRejectionIdentitySchema,
  ProvenanceHookRejectionMarkerSchema,
  ProvenanceRejectionMarkerOutcomeSchema,
  ValidatedProvenanceEventSchema,
  type HarnessId,
  type ProvenanceActorContext,
  type ProvenanceCaptureConfig,
  type ProvenanceCaptureDiagnostic,
  type ProvenanceCaptureResult,
  type RedactedProvenanceEvent,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";
import { ProvenanceRedactor } from "./redact-provenance-event.js";
import { ProvenanceActorResolver } from "./resolve-provenance-actor.js";
import { AdwProvenanceContextResolver } from "./resolve-provenance-context.js";
import { ProvenanceLedgerWriter } from "./write-provenance-ledger.js";
import {
  diagnosticMessageWithRemediation,
  PROVENANCE_LEDGER_SCHEMA_DRIFT,
} from "./sanitize-provenance-diagnostic.js";

export { ProvenanceCaptureResultSchema };
export const neverControlsWorkflow = true as const;

const CAPTURE_WARNINGS = {
  disabled: "Provenance activity capture is disabled; the workflow action was not affected.",
  input: "Provenance input or configuration was invalid; the workflow action was not affected.",
  normalize: "Provenance normalization failed; the workflow action was not affected.",
  actor: "Provenance attribution failed; the workflow action was not affected.",
  redact: "Provenance redaction failed; the workflow action was not affected.",
  degraded: "Provenance was written to only one local store; the workflow action was not affected.",
  unrecorded: "Provenance could not be written to either local store; the workflow action was not affected.",
  terminal: "Provenance capture ended unexpectedly; the workflow action was not affected.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookEventName(rawHookEvent: unknown): string {
  if (!isRecord(rawHookEvent)) return "";
  return typeof rawHookEvent.hook_event_name === "string"
    ? rawHookEvent.hook_event_name
    : "";
}

function diagnosticErrorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return /^[A-Za-z0-9._:-]+$/u.test(error.name)
      ? error.name.slice(0, 128)
      : "Error";
  }
  return "NonErrorFailure";
}

function diagnosticErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  if (typeof code !== "string" && typeof code !== "number") return undefined;
  const normalized = String(code);
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(normalized) ? normalized : undefined;
}

function diagnosticSchemaReasonCodes(error: unknown): string[] {
  if (!isRecord(error) || !isRecord(error.inspection)) return [];
  const reasonCodes = error.inspection.reasonCodes;
  if (!Array.isArray(reasonCodes)) return [];
  return reasonCodes.filter(
    (reasonCode): reasonCode is string =>
      typeof reasonCode === "string" &&
      /^[a-z0-9-]{1,64}$/u.test(reasonCode),
  );
}

function captureDiagnostic(
  stage: ProvenanceCaptureDiagnostic["stage"],
  error: unknown,
  projectRoot?: string,
): ProvenanceCaptureDiagnostic {
  const errorCode = diagnosticErrorCode(error);
  const diagnosticText = diagnosticMessageWithRemediation(
    error,
    stage,
    projectRoot,
    {
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(errorCode === PROVENANCE_LEDGER_SCHEMA_DRIFT
        ? { schemaReasonCodes: diagnosticSchemaReasonCodes(error) }
        : {}),
    },
  );
  return ProvenanceCaptureDiagnosticSchema.parse({
    stage,
    errorName: diagnosticErrorName(error),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...diagnosticText,
  });
}

function configuredProjectRoot(): string {
  const moduleProjectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const explicitProjectRoot = process.env.PROVENANCE_PROJECT_ROOT;
  return explicitProjectRoot === undefined
    ? moduleProjectRoot
    : resolve(explicitProjectRoot);
}

function resolveProjectLocalPath(projectRoot: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) {
    throw new Error("Provenance storage paths must be project-relative");
  }
  const destination = resolve(projectRoot, configuredPath);
  const pathFromRoot = relative(projectRoot, destination);
  if (
    pathFromRoot === "" ||
    /^\.\.(?:[\\/]|$)/u.test(pathFromRoot) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Provenance storage paths must remain inside the project root");
  }
  return destination;
}

function loadCaptureConfig(projectRoot: string): ProvenanceCaptureConfig {
  const configPath = join(
    projectRoot,
    ".agents",
    "provenance",
    "provenance.config.json",
  );
  return ProvenanceCaptureConfigSchema.parse(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
}

function adapterForHarness(harness: HarnessId): IProvenanceHarnessAdapter {
  return harness === "codex"
    ? new CodexProvenanceAdapter()
    : new ClaudeCodeProvenanceAdapter();
}

function captureResult(
  status: ProvenanceCaptureResult["status"],
  eventId: string,
  diagnostics: ProvenanceCaptureDiagnostic[],
  receipt?: ProvenanceCaptureResult["receipt"],
  integrityWarning?: string,
  rejectionMarkerOutcome?: ProvenanceCaptureResult["rejectionMarkerOutcome"],
): ProvenanceCaptureResult {
  return ProvenanceCaptureResultSchema.parse({
    status,
    eventId,
    ...(receipt === undefined ? {} : { receipt }),
    diagnostics,
    ...(integrityWarning === undefined ? {} : { integrityWarning }),
    ...(rejectionMarkerOutcome === undefined
      ? {}
      : { rejectionMarkerOutcome }),
  });
}

function contextualEvent(
  event: ValidatedProvenanceEvent,
): ValidatedProvenanceEvent {
  const context = new AdwProvenanceContextResolver().resolve(event);
  return ValidatedProvenanceEventSchema.parse({
    ...event,
    ...(context.workflowId === undefined
      ? { workflowId: undefined }
      : { workflowId: context.workflowId }),
    ...(context.taskId === undefined
      ? { taskId: undefined }
      : { taskId: context.taskId }),
  });
}

function createHookValidationRejectionEvent(
  harness: HarnessId,
  rawHookEvent: unknown,
  diagnostic: ProvenanceCaptureDiagnostic,
): ValidatedProvenanceEvent | undefined {
  if (!isRecord(rawHookEvent)) return undefined;
  const identityResult = ProvenanceHookRejectionIdentitySchema.safeParse({
    session_id: rawHookEvent.session_id,
    cwd: rawHookEvent.cwd,
    hook_event_name: rawHookEvent.hook_event_name,
    transcript_path: rawHookEvent.transcript_path,
  });
  if (!identityResult.success) return undefined;
  const eventNameResult = (
    harness === "claude-code"
      ? ClaudeCodeProvenanceEventNameSchema
      : CodexProvenanceEventNameSchema
  ).safeParse(identityResult.data.hook_event_name);
  if (!eventNameResult.success) return undefined;
  const markerResult = ProvenanceHookRejectionMarkerSchema.safeParse({
    markerType: "hook-validation-rejection",
    captureStatus: "unrecorded",
    stage: "normalize",
    errorName: diagnostic.errorName ?? "ProvenanceValidationError",
    ...(diagnostic.errorCode === undefined
      ? {}
      : { errorCode: diagnostic.errorCode }),
    sanitizedMessage: diagnostic.sanitizedMessage,
    ...(diagnostic.remediation === undefined
      ? {}
      : { remediation: diagnostic.remediation }),
  });
  if (!markerResult.success) return undefined;
  return ValidatedProvenanceEventSchema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    recordedAt: new Date().toISOString(),
    harness,
    eventName: eventNameResult.data,
    sessionId: identityResult.data.session_id,
    source: "provenance-validation",
    role: "unknown",
    ...(identityResult.data.transcript_path === undefined
      ? {}
      : { transcriptPath: identityResult.data.transcript_path }),
    cwd: identityResult.data.cwd,
    eventData: markerResult.data,
  });
}

async function persistValidatedProvenanceEvent(
  event: ValidatedProvenanceEvent,
  actorContextOverride?: ProvenanceActorContext,
): Promise<ProvenanceCaptureResult> {
  const diagnostics: ProvenanceCaptureDiagnostic[] = [];
  const projectRoot = configuredProjectRoot();
  let captureConfig: ProvenanceCaptureConfig;
  let ledgerPath: string;
  let jsonlDirectory: string;
  let actorStateDirectory: string;
  try {
    captureConfig = loadCaptureConfig(projectRoot);
    ledgerPath = resolveProjectLocalPath(projectRoot, captureConfig.paths.ledger);
    jsonlDirectory = resolveProjectLocalPath(
      projectRoot,
      captureConfig.paths.jsonlDirectory,
    );
    actorStateDirectory = resolveProjectLocalPath(
      projectRoot,
      captureConfig.paths.actorStateDirectory,
    );
  } catch (error) {
    diagnostics.push(captureDiagnostic("input", error, projectRoot));
    return captureResult(
      "unrecorded",
      event.eventId,
      diagnostics,
      undefined,
      CAPTURE_WARNINGS.input,
    );
  }

  if (!captureConfig.enabled) {
    return captureResult(
      "unrecorded",
      event.eventId,
      diagnostics,
      undefined,
      CAPTURE_WARNINGS.disabled,
    );
  }

  let attributedEvent: ValidatedProvenanceEvent;
  let actorContext: ProvenanceActorContext;
  try {
    attributedEvent = contextualEvent(event);
    actorContext =
      actorContextOverride ??
      new ProvenanceActorResolver({ actorStateDirectory }).resolve(attributedEvent);
  } catch (error) {
    diagnostics.push(captureDiagnostic("actor", error, projectRoot));
    return captureResult(
      "unrecorded",
      event.eventId,
      diagnostics,
      undefined,
      CAPTURE_WARNINGS.actor,
    );
  }

  let redactedEvent: RedactedProvenanceEvent;
  try {
    redactedEvent = new ProvenanceRedactor({
      projectRoot,
      maxFieldBytes: captureConfig.maxFieldBytes,
    }).redact(attributedEvent, actorContext);
  } catch (error) {
    diagnostics.push(captureDiagnostic("redact", error, projectRoot));
    return captureResult(
      "unrecorded",
      event.eventId,
      diagnostics,
      undefined,
      CAPTURE_WARNINGS.redact,
    );
  }

  let jsonlWritten = false;
  try {
    const jsonlMirror = new ProvenanceJsonlMirror(jsonlDirectory, {
      lockRetryCount: captureConfig.jsonl.lockRetryCount,
      lockRetryDelayMs: captureConfig.jsonl.lockRetryDelayMs,
      staleLockMs: captureConfig.jsonl.staleLockMs,
    });
    await jsonlMirror.append(redactedEvent);
    jsonlWritten = true;
  } catch (error) {
    diagnostics.push(captureDiagnostic("jsonl", error, projectRoot));
  }

  let receipt: ProvenanceCaptureResult["receipt"];
  let sqliteWritten = false;
  let ledgerWriter: ProvenanceLedgerWriter | undefined;
  try {
    // The native database is intentionally opened only after JSONL completes.
    ledgerWriter = new ProvenanceLedgerWriter(ledgerPath);
    receipt = ledgerWriter.insert(redactedEvent);
    sqliteWritten = true;
  } catch (error) {
    diagnostics.push(captureDiagnostic("sqlite", error, projectRoot));
  } finally {
    try {
      ledgerWriter?.close();
    } catch (error) {
      diagnostics.push(captureDiagnostic("sqlite", error, projectRoot));
    }
  }

  if (jsonlWritten && sqliteWritten) {
    return captureResult("recorded", redactedEvent.eventId, diagnostics, receipt);
  }
  if (jsonlWritten || sqliteWritten) {
    return captureResult(
      "degraded",
      redactedEvent.eventId,
      diagnostics,
      receipt,
      CAPTURE_WARNINGS.degraded,
    );
  }
  return captureResult(
    "unrecorded",
    redactedEvent.eventId,
    diagnostics,
    undefined,
    CAPTURE_WARNINGS.unrecorded,
  );
}

async function captureValidatedProvenanceEvent(
  harness: HarnessId,
  rawHookEvent: unknown,
  fallbackEventId: string,
): Promise<ProvenanceCaptureResult> {
  const validatedHarness = HarnessIdSchema.safeParse(harness);
  if (!validatedHarness.success) {
    const diagnostic = captureDiagnostic("normalize", validatedHarness.error);
    return captureResult(
      "unrecorded",
      fallbackEventId,
      [diagnostic],
      undefined,
      CAPTURE_WARNINGS.normalize,
    );
  }

  let event: ValidatedProvenanceEvent;
  try {
    event = adapterForHarness(validatedHarness.data).normalize(
      rawHookEvent,
      new Date().toISOString(),
    );
  } catch (error) {
    const diagnostic = captureDiagnostic("normalize", error);
    const rejectionEvent = createHookValidationRejectionEvent(
      validatedHarness.data,
      rawHookEvent,
      diagnostic,
    );
    if (rejectionEvent === undefined) {
      return captureResult(
        "unrecorded",
        fallbackEventId,
        [diagnostic],
        undefined,
        CAPTURE_WARNINGS.normalize,
      );
    }
    const rejectionResult = await persistValidatedProvenanceEvent(
      rejectionEvent,
      ProvenanceActorContextSchema.parse({
        source: "provenance-validation",
        role: "unknown",
      }),
    );
    const rejectionMarkerOutcome =
      ProvenanceRejectionMarkerOutcomeSchema.parse({
        eventId: rejectionResult.eventId,
        sessionId: rejectionEvent.sessionId,
        status: rejectionResult.status,
        ...(rejectionResult.receipt === undefined
          ? {}
          : { receipt: rejectionResult.receipt }),
        ...(rejectionResult.integrityWarning === undefined
          ? {}
          : { integrityWarning: rejectionResult.integrityWarning }),
      });
    return captureResult(
      "unrecorded",
      fallbackEventId,
      [diagnostic, ...rejectionResult.diagnostics],
      undefined,
      CAPTURE_WARNINGS.normalize,
      rejectionMarkerOutcome,
    );
  }

  return await persistValidatedProvenanceEvent(event);
}

export async function captureProvenanceEvent(
  harness: HarnessId,
  rawHookEvent: unknown,
): Promise<ProvenanceCaptureResult> {
  const fallbackEventId = randomUUID();
  try {
    return await captureValidatedProvenanceEvent(
      harness,
      rawHookEvent,
      fallbackEventId,
    );
  } catch (error) {
    const diagnostics = [
      captureDiagnostic("terminal", error, configuredProjectRoot()),
    ];
    return captureResult(
      "unrecorded",
      fallbackEventId,
      diagnostics,
      undefined,
      CAPTURE_WARNINGS.terminal,
    );
  }
}
