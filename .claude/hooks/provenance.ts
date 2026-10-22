import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureProvenanceEvent } from "../../.agents/provenance/capture-provenance-event.js";
import {
  diagnosticMessageWithRemediation,
  sanitizeProvenanceDiagnosticMessage,
} from "../../.agents/provenance/sanitize-provenance-diagnostic.js";
import type {
  ProvenanceCaptureDiagnostic,
  ProvenanceCaptureResult,
} from "../../.agents/provenance/provenance-schemas.js";

const DIAGNOSTIC_PREFIX = "Provenance hook diagnostic";
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const projectRoot = resolve(
  process.env.PROVENANCE_PROJECT_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);

let currentHookEventName = "unavailable";

function sanitizeDiagnosticMessage(value: unknown): string {
  return sanitizeProvenanceDiagnosticMessage(value, {
    projectRoot,
    fallback: "Unexpected provenance hook failure",
  });
}

function safeIdentifier(value: unknown, fallback = "unavailable"): string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value)
    ? value
    : fallback;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return safeIdentifier(error.name, "Error");
  }
  return "NonErrorFailure";
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unavailable";
  }
  const code = (error as { code?: unknown }).code;
  return safeIdentifier(
    typeof code === "number" ? String(code) : code,
  );
}

function sessionToken(sessionId: string): string {
  return `sha256:${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function field(name: string, value: string | number): string {
  return `${name}=${JSON.stringify(value)}`;
}

function writeDiagnostic(fields: Array<readonly [string, string | number]>): void {
  process.stderr.write(
    `${DIAGNOSTIC_PREFIX} ${fields.map(([name, value]) => field(name, value)).join(" ")}\n`,
  );
}

function diagnosticSummary(
  diagnostics: ProvenanceCaptureDiagnostic[],
  property: "stage" | "errorName" | "errorCode" | "sanitizedMessage" | "remediation",
  fallback: string,
): string {
  const values = diagnostics
    .map((diagnostic) => diagnostic[property])
    .filter((value): value is string => value !== undefined)
    .map((value) => sanitizeDiagnosticMessage(value));
  return values.length === 0
    ? fallback
    : sanitizeDiagnosticMessage([...new Set(values)].join("|"));
}

function writeCaptureWarning(
  hookEventName: string,
  captureResult: ProvenanceCaptureResult,
): void {
  const rejectionMarkerOutcome = captureResult.rejectionMarkerOutcome;
  const fields: Array<readonly [string, string | number]> = [
    ["harness", "claude-code"],
    ["hookEventName", hookEventName],
    ["captureStatus", captureResult.status],
    ["stage", diagnosticSummary(captureResult.diagnostics, "stage", "capture")],
    ...(rejectionMarkerOutcome === undefined
      ? ([["eventId", captureResult.eventId]] as const)
      : ([
          ["originalEventId", captureResult.eventId],
          ["markerEventId", rejectionMarkerOutcome.eventId],
          ["markerCaptureStatus", rejectionMarkerOutcome.status],
          ["markerSession", sessionToken(rejectionMarkerOutcome.sessionId)],
        ] as const)),
    [
      "errorName",
      diagnosticSummary(
        captureResult.diagnostics,
        "errorName",
        "ProvenanceCaptureWarning",
      ),
    ],
    [
      "errorCode",
      diagnosticSummary(captureResult.diagnostics, "errorCode", "unavailable"),
    ],
    [
      "message",
      diagnosticSummary(
        captureResult.diagnostics,
        "sanitizedMessage",
        sanitizeDiagnosticMessage(
          captureResult.integrityWarning ?? "Provenance capture warning",
        ),
      ),
    ],
    [
      "remediation",
      diagnosticSummary(
        captureResult.diagnostics,
        "remediation",
        "Review local provenance configuration; workflow execution can continue.",
      ),
    ],
  ];
  if (captureResult.receipt !== undefined) {
    fields.push(
      ["receiptSequence", captureResult.receipt.sequence],
      ["receiptSession", sessionToken(captureResult.receipt.sessionId)],
    );
  }
  if (rejectionMarkerOutcome?.receipt !== undefined) {
    fields.push(
      ["markerReceiptSequence", rejectionMarkerOutcome.receipt.sequence],
      [
        "markerReceiptSession",
        sessionToken(rejectionMarkerOutcome.receipt.sessionId),
      ],
    );
  }
  writeDiagnostic(fields);
}

function writeInputWarning(error: unknown): void {
  const diagnostic = diagnosticMessageWithRemediation(error, "input", projectRoot);
  writeDiagnostic([
    ["harness", "claude-code"],
    ["hookEventName", currentHookEventName],
    ["captureStatus", "invalid-input"],
    ["stage", "input"],
    ["eventId", "unavailable"],
    ["errorName", errorName(error)],
    ["errorCode", errorCode(error)],
    ["message", diagnostic.sanitizedMessage],
    ["remediation", diagnostic.remediation],
  ]);
}

function writeTerminalWarning(error: unknown): void {
  const diagnostic = diagnosticMessageWithRemediation(error, "terminal", projectRoot);
  writeDiagnostic([
    ["harness", "claude-code"],
    ["hookEventName", currentHookEventName],
    ["captureStatus", "unexpected-failure"],
    ["stage", "terminal"],
    ["eventId", "unavailable"],
    ["errorName", errorName(error)],
    ["errorCode", errorCode(error)],
    ["message", diagnostic.sanitizedMessage],
    ["remediation", diagnostic.remediation],
  ]);
}

async function readStdinOnce(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runClaudeProvenanceHook(): Promise<number> {
  let rawHookPayload: unknown;
  try {
    rawHookPayload = JSON.parse(await readStdinOnce());
  } catch (error) {
    writeInputWarning(error);
    return 0;
  }

  if (
    typeof rawHookPayload === "object" &&
    rawHookPayload !== null &&
    "hook_event_name" in rawHookPayload
  ) {
    currentHookEventName = safeIdentifier(
      (rawHookPayload as { hook_event_name?: unknown }).hook_event_name,
    );
  }
  const captureResult = await captureProvenanceEvent(
    "claude-code",
    rawHookPayload,
  );
  if (
    captureResult.integrityWarning !== undefined ||
    captureResult.diagnostics.length > 0 ||
    captureResult.status !== "recorded"
  ) {
    writeCaptureWarning(currentHookEventName, captureResult);
  }
  return 0;
}

void runClaudeProvenanceHook()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    writeTerminalWarning(error);
    process.exitCode = 0;
  });
