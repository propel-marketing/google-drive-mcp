import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";

import { captureProvenanceEvent } from "../../.agents/provenance/capture-provenance-event.js";
import type {
  ProvenanceCaptureDiagnostic,
  ProvenanceCaptureResult,
} from "../../.agents/provenance/provenance-schemas.js";

const DIAGNOSTIC_PREFIX = "Provenance hook diagnostic";
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAXIMUM_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;

let currentHookEventName = "unavailable";

function sanitizeDiagnosticMessage(value: unknown): string {
  let message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "Unexpected provenance hook failure";

  for (const [sensitivePath, token] of [
    [process.env.PROVENANCE_PROJECT_ROOT, "<PROJECT_ROOT>"],
    [homedir(), "<USER_HOME>"],
    [tmpdir(), "<TEMP_DIR>"],
  ] as const) {
    if (sensitivePath === undefined || sensitivePath.length === 0) {
      continue;
    }
    for (const variant of new Set([
      sensitivePath,
      sensitivePath.replaceAll("\\", "/"),
      sensitivePath.replaceAll("/", "\\"),
    ])) {
      message = message.split(variant).join(token);
    }
  }

  message = message
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(
      /\b(api[-_]?key|token|secret|password|authorization|cookie|private[-_]?key|client[-_]?secret)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED_SECRET]",
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "[REDACTED_CREDENTIAL]")
    .replace(
      /\b(?:sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|AKIA|ASIA|rk_live_|pk_live_)[A-Za-z0-9_\-]{8,}\b/gu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(
      /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@[^\s'"`]+/giu,
      "[REDACTED_CREDENTIAL_URL]",
    )
    .replace(
      /\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)[A-Za-z0-9_]*\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/giu,
      "[REDACTED_SECRET]",
    )
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

  if (message.length === 0) {
    return "Unexpected provenance hook failure";
  }
  return message.slice(0, MAXIMUM_DIAGNOSTIC_MESSAGE_LENGTH);
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
  property: "stage" | "errorName" | "errorCode" | "sanitizedMessage",
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
  const fields: Array<readonly [string, string | number]> = [
    ["harness", "codex"],
    ["hookEventName", hookEventName],
    ["captureStatus", captureResult.status],
    ["stage", diagnosticSummary(captureResult.diagnostics, "stage", "capture")],
    ["eventId", captureResult.eventId],
    [
      "errorName",
      diagnosticSummary(
        captureResult.diagnostics,
        "errorName",
        "ProvenanceIntegrityWarning",
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
  ];
  if (captureResult.receipt !== undefined) {
    fields.push(
      ["receiptSequence", captureResult.receipt.sequence],
      ["receiptSession", sessionToken(captureResult.receipt.sessionId)],
    );
  }
  writeDiagnostic(fields);
}

function writeInputWarning(error: unknown): void {
  writeDiagnostic([
    ["harness", "codex"],
    ["hookEventName", currentHookEventName],
    ["captureStatus", "invalid-input"],
    ["stage", "input"],
    ["eventId", "unavailable"],
    ["errorName", errorName(error)],
    ["errorCode", errorCode(error)],
    ["message", sanitizeDiagnosticMessage(error)],
  ]);
}

function writeTerminalWarning(error: unknown): void {
  writeDiagnostic([
    ["harness", "codex"],
    ["hookEventName", currentHookEventName],
    ["captureStatus", "unexpected-failure"],
    ["stage", "terminal"],
    ["eventId", "unavailable"],
    ["errorName", errorName(error)],
    ["errorCode", errorCode(error)],
    ["message", sanitizeDiagnosticMessage(error)],
  ]);
}

async function readStdinOnce(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runCodexProvenanceHook(): Promise<void> {
  let rawHookPayload: unknown;
  try {
    rawHookPayload = JSON.parse(await readStdinOnce());
  } catch (error) {
    writeInputWarning(error);
    return;
  }

  if (
    typeof rawHookPayload !== "object" ||
    rawHookPayload === null ||
    !("hook_event_name" in rawHookPayload) ||
    typeof (rawHookPayload as { hook_event_name?: unknown }).hook_event_name !==
      "string"
  ) {
    writeInputWarning(new TypeError("hook_event_name must be a string"));
    return;
  }

  currentHookEventName = safeIdentifier(
    (rawHookPayload as { hook_event_name: string }).hook_event_name,
  );
  const captureResult = await captureProvenanceEvent("codex", rawHookPayload);
  if (
    captureResult.integrityWarning !== undefined ||
    captureResult.diagnostics.length > 0 ||
    captureResult.status !== "recorded"
  ) {
    writeCaptureWarning(currentHookEventName, captureResult);
  }
}

void runCodexProvenanceHook()
  .catch((error: unknown) => {
    writeTerminalWarning(error);
  })
  .finally(() => {
    process.exitCode = 0;
  });
