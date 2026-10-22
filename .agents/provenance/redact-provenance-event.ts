import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

import type { IProvenanceRedactor } from "./provenance-contracts.js";
import {
  ProvenanceActorContextSchema,
  RedactedProvenanceEventSchema,
  type ProvenanceActorContext,
  type ProvenanceTruncatedField,
  type RedactedProvenanceEvent,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";

export const REDACTED = "[REDACTED]";
export const PROJECT_ROOT = "PROJECT_ROOT";
export const USER_HOME = "USER_HOME";
export const TEMP_DIR = "TEMP_DIR";

const sensitiveFieldName =
  /key|token|secret|password|authorization|cookie|private[ _-]?key|client[ _-]?secret/iu;

const sensitiveValuePatterns: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bBasic\s+[A-Za-z0-9+/]+={0,2}/giu,
  /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@[^\s'"`]+/giu,
];

const sensitiveEnvironmentAssignment =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)[A-Za-z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/giu;

function expressionMatches(expression: RegExp, value: string): boolean {
  expression.lastIndex = 0;
  const matches = expression.test(value);
  expression.lastIndex = 0;
  return matches;
}

export function containsSensitiveProvenanceValue(value: string): boolean {
  return (
    expressionMatches(sensitiveEnvironmentAssignment, value) ||
    sensitiveValuePatterns.some((expression) => expressionMatches(expression, value))
  );
}

type ProvenanceRedactorOptions = {
  projectRoot: string;
  maxFieldBytes: number;
  userHome?: string;
  temporaryDirectory?: string;
};

type RedactionState = {
  redactionCount: number;
  truncatedFields: ProvenanceTruncatedField[];
  sensitiveToolResponse: boolean;
};

type PathToken = {
  token: string;
  expression: RegExp;
  sourceLength: number;
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function crossPlatformAbsolutePath(pathValue: string): string {
  if (
    /^[A-Za-z]:[\\/]/u.test(pathValue) ||
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\\\")
  ) {
    return pathValue;
  }
  return resolve(pathValue);
}

function pathExpression(pathValue: string): RegExp {
  const absolutePath = crossPlatformAbsolutePath(pathValue);
  const pathSegments = absolutePath.split(/[\\/]+/u).filter(Boolean);
  if (pathSegments.length === 0) return /$a/u;
  const prefix = /^[A-Za-z]:[\\/]/u.test(absolutePath)
    ? `${escapeRegex(pathSegments.shift() ?? "")}[\\\\/]`
    : /^[\\/]/u.test(absolutePath)
      ? "[\\\\/]"
      : "";
  return new RegExp(
    `${prefix}${pathSegments.map(escapeRegex).join("[\\\\/]")}`,
    "giu",
  );
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString("utf8");
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringValues);
  }
  return [];
}

function isSensitiveFileReference(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/").toLowerCase();
  return (
    /(^|[\s'"`/])\.env(?:\.[^\s'"`/]*)?(?=$|[\s'"`])/u.test(normalized) ||
    /(^|\/)\.(?:npmrc|pypirc)(?=$|[\s'"`])/u.test(normalized) ||
    /(^|\/)\.ssh(?:\/|$)/u.test(normalized) ||
    /\.(?:pem|key)(?=$|[\s'"`])/u.test(normalized) ||
    /(^|\/)(?:credentials?|secrets?)(?:\.[^/\s'"`]*)?(?=$|[\s'"`])/u.test(normalized) ||
    /\.(?:vercel|claude|codex)\/[^\s'"`]*(?:auth|credential|token)/u.test(normalized)
  );
}

function targetsSensitiveFile(eventData: unknown): boolean {
  if (eventData === null || typeof eventData !== "object" || Array.isArray(eventData)) {
    return false;
  }
  const toolInput = (eventData as Record<string, unknown>).tool_input;
  return stringValues(toolInput).some(isSensitiveFileReference);
}

export class ProvenanceEventRedactor implements IProvenanceRedactor {
  private readonly maxFieldBytes: number;
  private readonly pathTokens: PathToken[];

  constructor(options: ProvenanceRedactorOptions) {
    if (!Number.isInteger(options.maxFieldBytes) || options.maxFieldBytes <= 0) {
      throw new RangeError("maxFieldBytes must be a positive integer");
    }
    this.maxFieldBytes = options.maxFieldBytes;
    this.pathTokens = [
      { token: PROJECT_ROOT, path: options.projectRoot },
      { token: USER_HOME, path: options.userHome ?? homedir() },
      { token: TEMP_DIR, path: options.temporaryDirectory ?? tmpdir() },
    ]
      .filter(({ path }) => path.length > 0)
      .map(({ token, path }) => ({
        token,
        expression: pathExpression(path),
        sourceLength: crossPlatformAbsolutePath(path).length,
      }))
      .sort((left, right) => right.sourceLength - left.sourceLength);
  }

  redact(
    provenanceEvent: ValidatedProvenanceEvent,
    actorContext: ProvenanceActorContext,
  ): RedactedProvenanceEvent {
    const state: RedactionState = {
      redactionCount: 0,
      truncatedFields: [],
      sensitiveToolResponse: targetsSensitiveFile(provenanceEvent.eventData),
    };
    const eventData = this.sanitizeValue(provenanceEvent.eventData, "eventData", state);
    const sanitizedContext = ProvenanceActorContextSchema.parse(
      this.sanitizeValue(actorContext, "actorContext", state),
    );
    const sessionId = this.sanitizeString(
      provenanceEvent.sessionId,
      "sessionId",
      state,
    );
    const toolName =
      provenanceEvent.toolName === undefined
        ? undefined
        : this.sanitizeString(provenanceEvent.toolName, "toolName", state);
    const toolUseId =
      provenanceEvent.toolUseId === undefined
        ? undefined
        : this.sanitizeString(provenanceEvent.toolUseId, "toolUseId", state);
    const cwd = this.sanitizeString(provenanceEvent.cwd, "cwd", state);
    const transcriptPath =
      provenanceEvent.transcriptPath === undefined
        ? undefined
        : this.sanitizeString(provenanceEvent.transcriptPath, "transcriptPath", state);
    const contentSha256 = sha256Text(canonicalJson({
      ...provenanceEvent,
      source: sanitizedContext.source,
      role: sanitizedContext.role,
      workflowId: sanitizedContext.workflowId,
      taskId: sanitizedContext.taskId,
      agentId: sanitizedContext.agentId,
      agentType: sanitizedContext.agentType,
      sessionId,
      toolName,
      toolUseId,
      cwd,
      transcriptPath,
      eventData,
    }));

    return RedactedProvenanceEventSchema.parse({
      ...provenanceEvent,
      source: sanitizedContext.source,
      role: sanitizedContext.role,
      sessionId,
      ...(toolName === undefined ? { toolName: undefined } : { toolName }),
      ...(toolUseId === undefined ? { toolUseId: undefined } : { toolUseId }),
      cwd,
      ...(transcriptPath === undefined ? { transcriptPath: undefined } : { transcriptPath }),
      ...(sanitizedContext.agentId === undefined
        ? { agentId: undefined }
        : { agentId: sanitizedContext.agentId }),
      ...(sanitizedContext.agentType === undefined
        ? { agentType: undefined }
        : { agentType: sanitizedContext.agentType }),
      ...(sanitizedContext.workflowId === undefined
        ? { workflowId: undefined }
        : { workflowId: sanitizedContext.workflowId }),
      ...(sanitizedContext.taskId === undefined
        ? { taskId: undefined }
        : { taskId: sanitizedContext.taskId }),
      eventData,
      redactionCount: state.redactionCount,
      truncatedFields: state.truncatedFields,
      contentSha256,
    });
  }

  private sanitizeValue(
    value: unknown,
    fieldPath: string,
    state: RedactionState,
  ): unknown {
    if (typeof value === "string") return this.sanitizeString(value, fieldPath, state);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") {
      return this.sanitizeString(value.toString(), fieldPath, state);
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) {
      return this.sanitizeString(Buffer.from(value).toString("base64"), fieldPath, state);
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        this.sanitizeValue(entry, `${fieldPath}[${index}]`, state),
      );
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return Object.fromEntries(
        entries.map(([key, entry]) => {
          const nestedPath = `${fieldPath}.${key}`;
          if (
            state.sensitiveToolResponse &&
            fieldPath === "eventData" &&
            key.toLowerCase() === "tool_response"
          ) {
            state.redactionCount += 1;
            return [key, REDACTED];
          }
          if (sensitiveFieldName.test(key)) {
            state.redactionCount += 1;
            return [key, REDACTED];
          }
          return [key, this.sanitizeValue(entry, nestedPath, state)];
        }),
      );
    }
    return value === undefined ? null : this.sanitizeString(String(value), fieldPath, state);
  }

  private sanitizeString(
    source: string,
    fieldPath: string,
    state: RedactionState,
  ): string {
    let sanitized = source;
    for (const pathToken of this.pathTokens) {
      sanitized = sanitized.replace(pathToken.expression, pathToken.token);
    }
    sanitized = sanitized.replace(
      sensitiveEnvironmentAssignment,
      (_match, name: string) => {
        state.redactionCount += 1;
        return `${name}=${REDACTED}`;
      },
    );
    for (const expression of sensitiveValuePatterns) {
      sanitized = sanitized.replace(expression, () => {
        state.redactionCount += 1;
        return REDACTED;
      });
    }

    const originalBytes = Buffer.byteLength(sanitized, "utf8");
    if (originalBytes <= this.maxFieldBytes) return sanitized;
    const truncated = utf8Prefix(sanitized, this.maxFieldBytes);
    state.truncatedFields.push({
      path: fieldPath,
      originalBytes,
      retainedBytes: Buffer.byteLength(truncated, "utf8"),
      sha256: sha256Text(sanitized),
    });
    return truncated;
  }
}

export { ProvenanceEventRedactor as ProvenanceRedactor };
