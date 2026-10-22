import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { IProvenanceJsonlMirror } from "./provenance-contracts.js";
import {
  RedactedProvenanceEventSchema,
  type RedactedProvenanceEvent,
} from "./provenance-schemas.js";

export type ProvenanceJsonlAppenderOptions = {
  lockRetryCount?: number;
  lockRetryDelayMs?: number;
  staleLockMs?: number;
};

const destinationQueues = new Map<string, Promise<void>>();

export class ProvenanceJsonlAppender implements IProvenanceJsonlMirror {
  private readonly lockRetryCount: number;
  private readonly lockRetryDelayMs: number;
  private readonly staleLockMs: number;

  constructor(
    private readonly jsonlDirectory: string,
    options: ProvenanceJsonlAppenderOptions = {},
  ) {
    this.lockRetryCount = options.lockRetryCount ?? 10;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 25;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    if (
      !Number.isInteger(this.lockRetryCount) ||
      this.lockRetryCount < 0 ||
      !Number.isInteger(this.lockRetryDelayMs) ||
      this.lockRetryDelayMs < 0 ||
      !Number.isInteger(this.staleLockMs) ||
      this.staleLockMs <= 0
    ) {
      throw new RangeError("Invalid provenance JSONL lock configuration");
    }
  }

  async append(provenanceEvent: RedactedProvenanceEvent): Promise<string> {
    const event = RedactedProvenanceEventSchema.parse(provenanceEvent);
    const destination = this.sessionJsonlPath(event.harness, event.sessionId);
    await mkdir(dirname(destination), { recursive: true });
    await this.enqueue(destination, () =>
      this.withSessionLock(destination, async () => {
        const file = await open(destination, "a");
        try {
          await file.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      }),
    );
    return destination;
  }

  private async withSessionLock(
    destination: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const lockPath = `${destination}.lock`;
    const lockToken = randomUUID();
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt <= this.lockRetryCount; attempt += 1) {
      try {
        lockHandle = await open(lockPath, "wx");
        await lockHandle.writeFile(
          JSON.stringify({
            token: lockToken,
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }),
          "utf8",
        );
        await lockHandle.sync();
        break;
      } catch (error) {
        if (!this.hasErrorCode(error, "EEXIST")) throw error;
        await this.removeStaleLock(lockPath);
        if (attempt === this.lockRetryCount) {
          throw new Error(
            `Unable to acquire provenance JSONL lock after ${attempt + 1} attempts`,
            { cause: error },
          );
        }
        await this.delay(this.contentionDelay(attempt));
      }
    }

    if (lockHandle === undefined) {
      throw new Error("Provenance JSONL lock acquisition failed");
    }
    try {
      await operation();
    } finally {
      await lockHandle.close();
      await this.removeOwnedLock(lockPath, lockToken);
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    const tombstonePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      const before = await readFile(lockPath, "utf8");
      const details = await stat(lockPath);
      if (Date.now() - details.mtimeMs > this.staleLockMs) {
        if ((await readFile(lockPath, "utf8")) !== before) return;
        await rename(lockPath, tombstonePath);
        await rm(tombstonePath, { force: true });
      }
    } catch (error) {
      if (!this.hasErrorCode(error, "ENOENT")) throw error;
    } finally {
      await rm(tombstonePath, { force: true });
    }
  }

  private async removeOwnedLock(lockPath: string, lockToken: string): Promise<void> {
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        token?: unknown;
      };
      if (lock.token === lockToken) await rm(lockPath, { force: true });
    } catch (error) {
      if (!this.hasErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  private sessionJsonlPath(
    harness: RedactedProvenanceEvent["harness"],
    sessionId: string,
  ): string {
    const sessionToken = createHash("sha256").update(sessionId).digest("hex");
    return join(this.jsonlDirectory, harness, `session-${sessionToken}.jsonl`);
  }

  private hasErrorCode(error: unknown, code: string): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === code
    );
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private contentionDelay(attempt: number): number {
    if (this.lockRetryDelayMs === 0) return 0;
    const exponential = Math.min(
      this.lockRetryDelayMs * 2 ** Math.min(attempt, 4),
      250,
    );
    return exponential + randomInt(0, this.lockRetryDelayMs + 1);
  }

  private async enqueue(
    destination: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = destinationQueues.get(destination) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    destinationQueues.set(destination, current);
    try {
      await current;
    } finally {
      if (destinationQueues.get(destination) === current) {
        destinationQueues.delete(destination);
      }
    }
  }
}

export { ProvenanceJsonlAppender as ProvenanceJsonlMirror };
export type ProvenanceJsonlMirrorOptions = ProvenanceJsonlAppenderOptions;
