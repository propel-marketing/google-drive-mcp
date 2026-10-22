import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { IProvenanceActorResolver } from "./provenance-contracts.js";
import {
  ProvenanceActorContextSchema,
  type ProvenanceActorContext,
  type ProvenanceActorRole,
  type ValidatedProvenanceEvent,
} from "./provenance-schemas.js";
import {
  containsSensitiveProvenanceValue,
  REDACTED,
} from "./redact-provenance-event.js";

const MAX_ACTIVE_ACTORS = 32;
const MAX_ACTOR_VALUE_BYTES = 256;
const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 10;
const STALE_LOCK_MS = 30_000;
const ORCHESTRATOR_SOURCES = new Set(["main", "jarvis", "orchestrator"]);
const LEAF_ROLE_SOURCES = new Set(["explore", "plan"]);

const ActorStateEntrySchema = z.object({
  stateId: z.string().uuid(),
  source: z.string().min(1).max(MAX_ACTOR_VALUE_BYTES),
  role: z.enum(["orchestrator", "agent", "explore", "plan", "unknown"]),
  agentId: z.string().min(1).max(MAX_ACTOR_VALUE_BYTES).optional(),
  agentType: z.string().min(1).max(MAX_ACTOR_VALUE_BYTES).optional(),
  correlationToken: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

const ActorStateSchema = z.object({
  schemaVersion: z.literal(1),
  correlationSalt: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  actors: z.array(ActorStateEntrySchema).max(MAX_ACTIVE_ACTORS),
});

type ActorState = z.infer<typeof ActorStateSchema>;
type ActorStateEntry = z.infer<typeof ActorStateEntrySchema>;
type ActorStateLock = { handle: number; token: string };

class ProvenanceActorStateError extends Error {
  readonly code: "ACTOR_STATE_INVALID" | "ACTOR_STATE_UNREADABLE";

  constructor(code: ProvenanceActorStateError["code"], message: string) {
    super(message);
    this.name = "ProvenanceActorStateError";
    this.code = code;
  }
}

export type ProvenanceActorResolverOptions = {
  actorStateDirectory?: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function resolveProvenanceRole(
  source: string,
  agentType?: string,
  agentId?: string,
): ProvenanceActorRole {
  const normalizedSource = source.trim().toLowerCase();
  const identity = agentType?.trim().toLowerCase() ?? normalizedSource;
  if (ORCHESTRATOR_SOURCES.has(identity)) return "orchestrator";
  if (identity === "explore") return "explore";
  if (identity === "plan") return "plan";
  if (agentId !== undefined || agentType !== undefined) return "agent";
  return "unknown";
}

function sanitizedActorValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (containsSensitiveProvenanceValue(value)) return REDACTED;
  if (
    byteLength > MAX_ACTOR_VALUE_BYTES ||
    /[\\/\r\n]/u.test(value)
  ) {
    return `actor-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  }
  return value;
}

function isActorSource(value: string | undefined): value is string {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return ORCHESTRATOR_SOURCES.has(normalized) || LEAF_ROLE_SOURCES.has(normalized);
}

function createActorCorrelationToken(
  correlationSalt: string,
  identityKind: "agent-id" | "agent-type",
  identity: string,
): string {
  return createHmac("sha256", correlationSalt)
    .update(`${identityKind}\0${identity}`)
    .digest("hex");
}

function explicitActor(
  event: ValidatedProvenanceEvent,
  correlationSalt?: string,
): ActorStateEntry | undefined {
  const raw =
    event.eventData !== null && typeof event.eventData === "object"
      ? (event.eventData as Record<string, unknown>)
      : {};
  const rawSource = optionalString(raw.source);
  const rawAgentType = optionalString(raw.agent_type) ?? event.agentType;
  const rawAgentId = optionalString(raw.agent_id) ?? event.agentId;
  const actorSource = isActorSource(rawSource)
    ? rawSource
    : isActorSource(event.source)
      ? event.source
      : undefined;
  if (actorSource === undefined && rawAgentType === undefined && rawAgentId === undefined) {
    return undefined;
  }
  const source =
    sanitizedActorValue(rawAgentType ?? actorSource ?? "agent") ?? "agent";
  const agentType = sanitizedActorValue(rawAgentType);
  const agentId = sanitizedActorValue(rawAgentId);
  const sensitiveIdentity =
    rawAgentId !== undefined && containsSensitiveProvenanceValue(rawAgentId)
      ? { kind: "agent-id" as const, value: rawAgentId }
      : rawAgentType !== undefined && containsSensitiveProvenanceValue(rawAgentType)
        ? { kind: "agent-type" as const, value: rawAgentType }
        : undefined;
  const correlationToken =
    correlationSalt !== undefined && sensitiveIdentity !== undefined
      ? createActorCorrelationToken(
          correlationSalt,
          sensitiveIdentity.kind,
          sensitiveIdentity.value,
        )
      : undefined;
  return ActorStateEntrySchema.parse({
    stateId: randomUUID(),
    source,
    role: resolveProvenanceRole(source, agentType, agentId),
    ...(agentId === undefined ? {} : { agentId }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(correlationToken === undefined ? {} : { correlationToken }),
  });
}

function eventContext(
  event: ValidatedProvenanceEvent,
  actor: ActorStateEntry,
): ProvenanceActorContext {
  return ProvenanceActorContextSchema.parse({
    ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    source: actor.source,
    role: actor.role,
    ...(actor.agentId === undefined ? {} : { agentId: actor.agentId }),
    ...(actor.agentType === undefined ? {} : { agentType: actor.agentType }),
  });
}

export class ProvenanceActorResolver implements IProvenanceActorResolver {
  private readonly actorStateDirectory: string | undefined;

  constructor(options: ProvenanceActorResolverOptions | string = {}) {
    this.actorStateDirectory =
      typeof options === "string" ? options : options.actorStateDirectory;
  }

  resolve(event: ValidatedProvenanceEvent): ProvenanceActorContext {
    const defaultActor = ActorStateEntrySchema.parse({
      stateId: randomUUID(),
      source: "main",
      role: "orchestrator",
    });

    if (this.actorStateDirectory === undefined) {
      return eventContext(event, explicitActor(event) ?? defaultActor);
    }

    return this.withSessionState(event, (state) => {
      if (event.eventName === "SessionStart") {
        state.actors = [];
        state.correlationSalt = randomBytes(32).toString("hex");
      } else if (event.eventName === "SessionEnd") {
        state.actors = [];
      }
      state.correlationSalt ??= randomBytes(32).toString("hex");
      const explicit = explicitActor(event, state.correlationSalt);
      if (event.eventName === "SubagentStart") {
        const actor = explicit ?? defaultActor;
        if (actor.role !== "orchestrator" && actor.role !== "unknown") {
          state.actors.push(actor);
          state.actors = state.actors.slice(-MAX_ACTIVE_ACTORS);
        }
        return eventContext(event, actor);
      }
      if (event.eventName === "SubagentStop") {
        const actor = explicit ?? state.actors.at(-1) ?? defaultActor;
        const index = this.matchingActorIndex(state, actor);
        if (index >= 0) state.actors.splice(index, 1);
        return eventContext(event, actor);
      }
      return eventContext(event, explicit ?? defaultActor);
    });
  }

  private withSessionState(
    event: ValidatedProvenanceEvent,
    operation: (state: ActorState) => ProvenanceActorContext,
  ): ProvenanceActorContext {
    mkdirSync(this.actorStateDirectory!, { recursive: true });
    const token = createHash("sha256")
      .update(`${event.harness}\0${event.sessionId}`)
      .digest("hex");
    const statePath = join(this.actorStateDirectory!, `session-${token}.json`);
    const lockPath = `${statePath}.lock`;
    const lock = this.acquireLock(lockPath);
    try {
      const state = this.readState(statePath);
      const context = operation(state);
      this.writeState(statePath, state);
      return context;
    } finally {
      this.releaseLock(lockPath, lock);
    }
  }

  private acquireLock(lockPath: string): ActorStateLock {
    const token = randomUUID();
    for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt += 1) {
      try {
        const handle = openSync(lockPath, "wx");
        try {
          writeFileSync(
            handle,
            JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }),
            "utf8",
          );
          fsyncSync(handle);
          return { handle, token };
        } catch (error) {
          closeSync(handle);
          this.removeOwnedLock(lockPath, token);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.removeStaleLock(lockPath);
        if (attempt === LOCK_RETRY_COUNT) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
      }
    }
    throw new Error("Unable to acquire provenance actor-state lock");
  }

  private releaseLock(lockPath: string, lock: ActorStateLock): void {
    closeSync(lock.handle);
    this.removeOwnedLock(lockPath, lock.token);
  }

  private removeStaleLock(lockPath: string): void {
    const tombstonePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      const before = readFileSync(lockPath, "utf8");
      if (Date.now() - statSync(lockPath).mtimeMs <= STALE_LOCK_MS) return;
      if (readFileSync(lockPath, "utf8") !== before) return;
      renameSync(lockPath, tombstonePath);
      rmSync(tombstonePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      rmSync(tombstonePath, { force: true });
    }
  }

  private removeOwnedLock(lockPath: string, token: string): void {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
      if (parsed.token === token) rmSync(lockPath, { force: true });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }
  }

  private readState(statePath: string): ActorState {
    if (!existsSync(statePath)) {
      return {
        schemaVersion: 1,
        correlationSalt: randomBytes(32).toString("hex"),
        actors: [],
      };
    }
    try {
      const parsed = ActorStateSchema.safeParse(
        JSON.parse(readFileSync(statePath, "utf8")),
      );
      if (parsed.success) return parsed.data;
      throw new ProvenanceActorStateError(
        "ACTOR_STATE_INVALID",
        "Existing provenance actor state is invalid",
      );
    } catch (error) {
      if (error instanceof ProvenanceActorStateError) throw error;
      throw new ProvenanceActorStateError(
        "ACTOR_STATE_UNREADABLE",
        "Existing provenance actor state could not be read",
      );
    }
  }

  private writeState(statePath: string, state: ActorState): void {
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(ActorStateSchema.parse(state)), {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      renameSync(temporaryPath, statePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  private matchingActorIndex(state: ActorState, actor: ActorStateEntry): number {
    for (let index = state.actors.length - 1; index >= 0; index -= 1) {
      const candidate = state.actors[index]!;
      if (
        actor.correlationToken !== undefined
          ? candidate.correlationToken === actor.correlationToken
          : actor.agentId !== undefined
          ? candidate.agentId === actor.agentId
          : candidate.agentType === actor.agentType && candidate.source === actor.source
      ) {
        return index;
      }
    }
    return -1;
  }
}
