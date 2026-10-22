import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import type { ProvenanceCaptureDiagnostic } from "./provenance-schemas.js";

export const MAXIMUM_PROVENANCE_DIAGNOSTIC_LENGTH = 1_024;
export const MAXIMUM_PROVENANCE_STRUCTURED_ARRAY_LENGTH = 100;
export const MAXIMUM_PROVENANCE_STRUCTURED_OBJECT_ENTRIES = 100;
export const PROJECT_ROOT = "<PROJECT_ROOT>";
export const USER_HOME = "<USER_HOME>";
export const TEMP_DIR = "<TEMP_DIR>";
export const PROVENANCE_LEDGER_SCHEMA_DRIFT =
  "PROVENANCE_LEDGER_SCHEMA_DRIFT" as const;

const RECOVERY_MARKER_PRESENT = "recovery-marker-present" as const;

const UNSAFE_STRUCTURED_OUTPUT_KEYS = new Set([
  "cause",
  "eventData",
  "events",
  "input",
  "payload",
  "redacted_event_json",
  "sanitized_payload_json",
  "stack",
]);

const REMEDIATION_BY_STAGE: Record<
  ProvenanceCaptureDiagnostic["stage"],
  string
> = {
  input:
    "Run node scripts/init.mjs --check and review the local provenance configuration; workflow execution can continue.",
  normalize:
    "Review the hook event fields and local provenance configuration; workflow execution can continue.",
  actor:
    "Inspect the local provenance actor-state file and directory permissions; workflow execution can continue.",
  redact:
    "Review the local provenance redaction configuration; workflow execution can continue.",
  jsonl:
    "Check the configured local JSONL directory and permissions; workflow execution can continue.",
  sqlite:
    "Check the configured local SQLite path and permissions; workflow execution can continue.",
  terminal:
    "Run node scripts/init.mjs --check and retry provenance capture; workflow execution can continue.",
};

export function provenanceDiagnosticRemediation(
  stage: ProvenanceCaptureDiagnostic["stage"],
  cause: {
    errorCode?: string;
    schemaReasonCodes?: readonly string[];
  } = {},
): string {
  if (
    cause.errorCode === PROVENANCE_LEDGER_SCHEMA_DRIFT &&
    cause.schemaReasonCodes?.includes(RECOVERY_MARKER_PRESENT)
  ) {
    return "Wait for the active provenance recovery to finish, inspect with node scripts/init.mjs --check, then retry capture while leaving the recovery marker untouched; workflow execution can continue.";
  }
  if (cause.errorCode === PROVENANCE_LEDGER_SCHEMA_DRIFT) {
    return "Run node scripts/init.mjs --check to diagnose the provenance ledger, then run node scripts/init.mjs for explicit recovery; workflow execution can continue.";
  }
  return REMEDIATION_BY_STAGE[stage];
}

export function sanitizeProvenanceDiagnosticMessage(
  value: unknown,
  options: {
    projectRoot?: string;
    fallback?: string;
    maxLength?: number;
  } = {},
): string {
  let message =
    value instanceof Error
      ? value.message || value.name
      : typeof value === "string"
        ? value
        : options.fallback ?? "Unexpected provenance failure";

  for (const token of diagnosticPathTokens(options.projectRoot)) {
    message = message.split(token.sourcePath).join(token.replacement);
  }

  message = message
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(
      /\b(?:sk-ant-|sk-proj-|sk-svcacct-|sk-|gh[pousr]_|github_pat_|AKIA|ASIA|sk_live_|rk_live_|sk_test_|rk_test_)[A-Za-z0-9_\-]{8,}\b/gu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "[REDACTED_CREDENTIAL]")
    .replace(
      /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@[^\s'"`]+/giu,
      "[REDACTED_CREDENTIAL_URL]",
    )
    .replace(
      /\b(?:api[-_ ]?key|token|secret|password|authorization|cookie|private[-_ ]?key|client[-_ ]?secret)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/giu,
      "[REDACTED_SECRET]",
    )
    .replace(
      /\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)[A-Za-z0-9_]*\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/giu,
      "[REDACTED_SECRET]",
    )
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

  const fallback = options.fallback ?? "Unexpected provenance failure";
  const maxLength = Math.max(1, options.maxLength ?? MAXIMUM_PROVENANCE_DIAGNOSTIC_LENGTH);
  return (message || fallback).slice(0, maxLength);
}

/**
 * Produces a bounded JSON-compatible view for inspections and recovery output.
 * Raw event/payload/error internals are deliberately omitted at this boundary.
 */
export function projectProvenanceStructuredOutput(
  value: unknown,
  options: { projectRoot?: string } = {},
): unknown {
  return projectStructuredValue(value, options.projectRoot, 0);
}

export function diagnosticMessageWithRemediation(
  error: unknown,
  stage: ProvenanceCaptureDiagnostic["stage"],
  projectRoot?: string,
  cause: {
    errorCode?: string;
    schemaReasonCodes?: readonly string[];
  } = {},
): { sanitizedMessage: string; remediation: string } {
  const remediation = provenanceDiagnosticRemediation(stage, cause);
  const suffix = ` Safe next step: ${remediation}`;
  const sanitizedMessage = `${sanitizeProvenanceDiagnosticMessage(error, {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    maxLength: MAXIMUM_PROVENANCE_DIAGNOSTIC_LENGTH - suffix.length,
  })}${suffix}`;
  return { sanitizedMessage, remediation };
}

function diagnosticPathTokens(
  projectRoot?: string,
): Array<{ sourcePath: string; replacement: string }> {
  const candidates: Array<[string | undefined, string]> = [
    [projectRoot, PROJECT_ROOT],
    [physicalPath(projectRoot), PROJECT_ROOT],
    [homedir(), USER_HOME],
    [physicalPath(homedir()), USER_HOME],
    [tmpdir(), TEMP_DIR],
    [physicalPath(tmpdir()), TEMP_DIR],
  ];
  const values = new Map<string, string>();
  for (const [pathValue, replacement] of candidates) {
    if (pathValue === undefined || pathValue.length === 0) continue;
    for (const variant of crossPlatformPathVariants(pathValue)) {
      if (variant.length > 0) values.set(variant, replacement);
    }
  }
  return [...values].map(([sourcePath, replacement]) => ({
    sourcePath,
    replacement,
  })).sort((left, right) => right.sourcePath.length - left.sourcePath.length);
}

function projectStructuredValue(
  value: unknown,
  projectRoot: string | undefined,
  depth: number,
): unknown {
  if (depth >= 10) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") {
    return sanitizeProvenanceDiagnosticMessage(value, {
      ...(projectRoot === undefined ? {} : { projectRoot }),
      fallback: "[EMPTY]",
    });
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAXIMUM_PROVENANCE_STRUCTURED_ARRAY_LENGTH)
      .map((entry) => projectStructuredValue(entry, projectRoot, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSAFE_STRUCTURED_OUTPUT_KEYS.has(key))
        .slice(0, MAXIMUM_PROVENANCE_STRUCTURED_OBJECT_ENTRIES)
        .map(([key, entry]) => [
          key,
          projectStructuredValue(entry, projectRoot, depth + 1),
        ]),
    );
  }
  return "[OMITTED_UNSUPPORTED_VALUE]";
}

function crossPlatformPathVariants(pathValue: string): Set<string> {
  const variants = new Set([
    pathValue,
    pathValue.replaceAll("\\", "/"),
    pathValue.replaceAll("/", "\\"),
  ]);
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/u.exec(pathValue);
  if (driveMatch !== null) {
    variants.add(`/mnt/${driveMatch[1]!.toLowerCase()}/${driveMatch[2]!.replaceAll("\\", "/")}`);
  }
  const wslMatch = /^\/mnt\/([A-Za-z])\/(.*)$/u.exec(pathValue.replaceAll("\\", "/"));
  if (wslMatch !== null) {
    const tail = wslMatch[2]!;
    variants.add(`${wslMatch[1]!.toUpperCase()}:/${tail}`);
    variants.add(`${wslMatch[1]!.toUpperCase()}:\\${tail.replaceAll("/", "\\")}`);
  }
  return variants;
}

function physicalPath(pathValue: string | undefined): string | undefined {
  if (pathValue === undefined) return undefined;
  try {
    return realpathSync.native(pathValue);
  } catch {
    return undefined;
  }
}
