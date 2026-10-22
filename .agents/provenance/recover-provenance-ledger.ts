import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import type {
  IProvenanceJsonlReplayReader,
  IProvenanceLedgerRecoveryService,
  IProvenanceLedgerSchemaInspector,
} from "./provenance-contracts.js";
import {
  provenanceLedgerRecoveryMarkerPath,
  ProvenanceLedgerSchemaInspector,
} from "./provenance-ledger-definition.js";
import {
  deriveProvenanceLedgerRecoveryNextAction,
  ProvenanceJsonlReplayInventorySchema,
  ProvenanceLedgerArchiveSchema,
  ProvenanceLedgerRecoveryRequestSchema,
  ProvenanceLedgerRecoveryResultSchema,
  type ProvenanceJsonlReplayInventory,
  type ProvenanceLedgerArchive,
  type ProvenanceLedgerRecoveryRequest,
  type ProvenanceLedgerRecoveryResult,
  type ProvenanceLedgerSchemaInspection,
  type ValidatedProvenanceJsonlReplay,
} from "./provenance-ledger-schemas.js";
import { ProvenanceJsonlReplayReader } from "./read-provenance-jsonl-replay.js";
import { ProvenanceLedgerWriter } from "./write-provenance-ledger.js";

type RebuildOutcome = {
  archive: ProvenanceLedgerArchive;
  replayedEventCount: number;
};

type PreparedRebuild = RebuildOutcome & {
  replacementDatabaseFile: string;
  replacementDatabaseSha256: string;
  movedArtifacts: Array<{ source: string; destination: string }>;
};

const InterruptedApplySchema = z.object({
  schemaVersion: z.literal(1),
  originalState: z.enum(["missing", "unstamped-current", "incompatible"]),
  replayedEventCount: z.number().int().nonnegative().default(0),
  archive: ProvenanceLedgerArchiveSchema.optional(),
  replacementDatabaseFile: z.string().min(1).optional(),
  replacementDatabaseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

type InterruptedApply = z.infer<typeof InterruptedApplySchema>;

type ProvenanceLedgerRecoveryTestHooks = {
  afterReplayInsert?: (insertedEventCount: number, databasePath: string) => void;
  afterPreparedProgress?: () => void;
  afterReplacementInstall?: () => void;
  afterStampClose?: () => void;
  beforeFinalInspection?: () => void;
  writeRecoveryMarker?: (descriptor: number, contents: string) => void;
  closeRecoveryMarker?: (descriptor: number) => void;
  removeRecoveryMarker?: (markerPath: string) => void;
  restoreArchivedArtifact?: (source: string, destination: string) => void;
  closeReplayWriter?: (writer: ProvenanceLedgerWriter) => void;
  removeTemporaryArtifact?: (temporaryPath: string) => void;
  closeStampDatabase?: (database: Database.Database) => void;
  removeInterruptedApply?: (interruptedApplyPath: string) => void;
};

const EMPTY_REPLAY_INVENTORY = ProvenanceJsonlReplayInventorySchema.parse({
  jsonlFileCount: 0,
  nonBlankLineCount: 0,
  validEventCount: 0,
  duplicateEventCount: 0,
  conflictingEventCount: 0,
  invalidRecordCount: 0,
  issues: [],
});

export class ProvenanceLedgerRecoveryBlockedError extends Error {
  readonly code = "PROVENANCE_LEDGER_RECOVERY_BLOCKED" as const;

  constructor(readonly result: ProvenanceLedgerRecoveryResult) {
    super(
      "Provenance ledger recovery is blocked by conflicting replay evidence or another active recovery.",
    );
    this.name = "ProvenanceLedgerRecoveryBlockedError";
  }
}

export const PROVENANCE_LEDGER_RECOVERY_OPERATION_STAGES = [
  "recovery",
  "archive",
  "replacement",
  "rollback",
  "cleanup",
  "recovery-marker",
  "catch-up",
  "final-inspection",
] as const;

export type ProvenanceLedgerRecoveryOperationStage =
  (typeof PROVENANCE_LEDGER_RECOVERY_OPERATION_STAGES)[number];

export type ProvenanceLedgerRecoveryOperationEvidence = {
  archiveToken?: string;
  markerToken?: string;
  markerPresent?: boolean;
  replacementToken?: string;
};

type ProvenanceLedgerRecoveryOperationContext = {
  stage: ProvenanceLedgerRecoveryOperationStage;
  message: string;
  evidence: ProvenanceLedgerRecoveryOperationEvidence;
};

const recoveryOperationContexts = new WeakMap<
  object,
  ProvenanceLedgerRecoveryOperationContext
>();

export class ProvenanceLedgerRecoveryOperationError extends Error {
  readonly code:
    | "PROVENANCE_LEDGER_RECOVERY_OPERATION_FAILED"
    | "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED";

  constructor(
    readonly stage: ProvenanceLedgerRecoveryOperationStage,
    message: string,
    readonly evidence: ProvenanceLedgerRecoveryOperationEvidence = {},
    options: ErrorOptions = {},
    code:
      | "PROVENANCE_LEDGER_RECOVERY_OPERATION_FAILED"
      | "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED" =
      "PROVENANCE_LEDGER_RECOVERY_OPERATION_FAILED",
  ) {
    super(message, options);
    this.name = "ProvenanceLedgerRecoveryOperationError";
    this.code = code;
  }
}

export class ProvenanceLedgerRecoveryCleanupError extends ProvenanceLedgerRecoveryOperationError {
  readonly code = "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED" as const;

  constructor(
    message: string,
    errors: unknown[],
    evidence: ProvenanceLedgerRecoveryOperationEvidence = {},
  ) {
    super(
      "cleanup",
      message,
      evidence,
      { cause: new AggregateError(errors) },
      "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED",
    );
    this.name = "ProvenanceLedgerRecoveryCleanupError";
  }
}

export class ProvenanceLedgerRecoveryService
  implements IProvenanceLedgerRecoveryService
{
  constructor(
    private readonly databasePath: string,
    private readonly jsonlDirectory: string,
    private readonly schemaInspector: IProvenanceLedgerSchemaInspector =
      new ProvenanceLedgerSchemaInspector(),
    private readonly replayReader: IProvenanceJsonlReplayReader =
      new ProvenanceJsonlReplayReader(),
    private readonly installReplacement: (
      temporaryDatabasePath: string,
      databasePath: string,
    ) => void = renameSync,
    private readonly testHooks: ProvenanceLedgerRecoveryTestHooks = {},
  ) {}

  inspect(): ProvenanceLedgerSchemaInspection {
    return this.schemaInspector.inspect(this.databasePath);
  }

  async recover(
    recoveryRequest: ProvenanceLedgerRecoveryRequest,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    try {
      return await this.recoverInternal(recoveryRequest);
    } catch (error) {
      if (
        error instanceof ProvenanceLedgerRecoveryBlockedError ||
        error instanceof ProvenanceLedgerRecoveryOperationError
      ) {
        throw error;
      }
      throw this.tagOperationFailure(
        "recovery",
        error,
        "Provenance ledger recovery operation failed",
      );
    }
  }

  async recoverForCli(
    recoveryRequest: ProvenanceLedgerRecoveryRequest,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    try {
      return await this.recover(recoveryRequest);
    } catch (error) {
      if (
        error instanceof ProvenanceLedgerRecoveryBlockedError ||
        error instanceof ProvenanceLedgerRecoveryOperationError
      ) {
        throw error;
      }
      const context = this.operationContext(error) ?? {
        stage: "recovery" as const,
        message: "Provenance ledger recovery operation failed",
        evidence: {},
      };
      if (context.stage === "cleanup") {
        throw new ProvenanceLedgerRecoveryCleanupError(
          context.message,
          [error],
          context.evidence,
        );
      }
      throw this.operationFailure(
        context.stage,
        error,
        context.message,
        context.evidence,
      );
    }
  }

  private async recoverInternal(
    recoveryRequest: ProvenanceLedgerRecoveryRequest,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    const request = ProvenanceLedgerRecoveryRequestSchema.parse(recoveryRequest);
    const before = this.inspect();
    if (before.recoveryMarkerPresent) {
      return this.blockOrThrow(
        request.mode,
        before,
        EMPTY_REPLAY_INVENTORY,
        false,
      );
    }

    const interruptedApply = this.readInterruptedApply();
    if (interruptedApply !== undefined && request.mode === "dry-run") {
      return this.blockOrThrow(
        request.mode,
        before,
        EMPTY_REPLAY_INVENTORY,
        true,
      );
    }

    if (before.state === "current" && interruptedApply === undefined) {
      return this.result({
        mode: request.mode,
        status: "current",
        before,
        after: before,
        replay: EMPTY_REPLAY_INVENTORY,
        replayedEventCount: 0,
        catchUpEventCount: 0,
        semanticReindexRequired: false,
        recoveryMarkerCleared: true,
      });
    }

    if (request.mode === "apply" && interruptedApply !== undefined) {
      return this.resumeInterruptedApply(before, interruptedApply);
    }

    if (before.state === "unstamped-current") {
      if (request.mode === "dry-run") {
        return this.result({
          mode: request.mode,
          status: "would-stamp",
          before,
          replay: EMPTY_REPLAY_INVENTORY,
          replayedEventCount: 0,
          catchUpEventCount: 0,
          semanticReindexRequired: false,
          recoveryMarkerCleared: true,
        });
      }
      return this.applyStamp(before);
    }

    const replay = await this.replayReader.read(this.jsonlDirectory);
    if (hasBlockingReplayIssues(replay)) {
      return this.blockOrThrow(
        request.mode,
        before,
        replayInventory(replay),
        true,
      );
    }

    if (request.mode === "dry-run") {
      return this.result({
        mode: request.mode,
        status: before.state === "missing" ? "would-create" : "would-rebuild",
        before,
        replay: replayInventory(replay),
        replayedEventCount: replay.events.length,
        catchUpEventCount: 0,
        semanticReindexRequired: replay.events.length > 0,
        recoveryMarkerCleared: true,
      });
    }

    if (before.state === "missing") {
      return this.applyCreate(before, replay);
    }

    return this.rebuildIncompatibleLedger(before, replay);
  }

  private async rebuildIncompatibleLedger(
    before: ProvenanceLedgerSchemaInspection,
    initialReplay: ValidatedProvenanceJsonlReplay,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    const initialInterruptedApply: InterruptedApply = {
      schemaVersion: 1,
      originalState: "incompatible",
      replayedEventCount: 0,
    };
    this.writeInterruptedApply(
      initialInterruptedApply,
      !existsSync(this.interruptedApplyPath()),
    );
    const rebuild = await this.withRecoveryMarker(
      before,
      initialReplay,
      async () => {
        const lockedReplay = await this.replayReader.read(this.jsonlDirectory);
        if (hasBlockingReplayIssues(lockedReplay)) {
          throw new ProvenanceLedgerRecoveryBlockedError(
            this.blockedResult(before, replayInventory(lockedReplay), undefined),
          );
        }
        const preparedRebuild = this.prepareArchiveAndReplacement(
          lockedReplay,
          (preparedOutcome) => {
            this.writeInterruptedApply({
              ...initialInterruptedApply,
              archive: preparedOutcome.archive,
              replayedEventCount: preparedOutcome.replayedEventCount,
              replacementDatabaseFile:
                preparedOutcome.replacementDatabaseFile,
              replacementDatabaseSha256:
                preparedOutcome.replacementDatabaseSha256,
            });
          },
        );
        this.testHooks.afterPreparedProgress?.();
        const rebuildOutcome = this.installPreparedReplacement(preparedRebuild);
        this.testHooks.afterReplacementInstall?.();
        return { lockedReplay, rebuildOutcome };
      },
    );
    const catchUp = await this.replayCatchUp(
      before,
      rebuild.rebuildOutcome.archive,
      rebuild.rebuildOutcome.replayedEventCount,
    );
    const after = this.finishInterruptedApply();
    return this.result({
      mode: "apply",
      status: "rebuilt",
      before,
      after,
      replay: replayInventory(catchUp.replay),
      replayedEventCount: rebuild.rebuildOutcome.replayedEventCount,
      catchUpEventCount: catchUp.insertedEventCount,
      archive: rebuild.rebuildOutcome.archive,
      semanticReindexRequired:
        rebuild.rebuildOutcome.replayedEventCount + catchUp.insertedEventCount > 0,
      recoveryMarkerCleared: true,
    });
  }

  private prepareArchiveAndReplacement(
    replay: ValidatedProvenanceJsonlReplay,
    persistPreparedOutcome: (preparedRebuild: PreparedRebuild) => void,
  ): PreparedRebuild {
    const parentDirectory = dirname(this.databasePath);
    const uniqueToken = `${Date.now()}-${randomUUID()}`;
    const temporaryDatabasePath = join(
      parentDirectory,
      `.${basename(this.databasePath)}.${uniqueToken}.rebuild`,
    );
    const archiveDirectory = join(
      parentDirectory,
      `${basename(this.databasePath)}.archive-${uniqueToken}`,
    );
    const movedArtifacts: Array<{ source: string; destination: string }> = [];

    let primaryError: unknown;
    try {
      const replayedEventCount = this.writeReplayDatabase(
        temporaryDatabasePath,
        replay,
      );
      const temporaryInspection = this.schemaInspector.inspect(
        temporaryDatabasePath,
      );
      if (
        temporaryInspection.state !== "current" ||
        temporaryInspection.recoveryMarkerPresent
      ) {
        throw new Error("Temporary provenance ledger is not current");
      }

      mkdirSync(archiveDirectory);
      for (const source of [
        this.databasePath,
        `${this.databasePath}-wal`,
        `${this.databasePath}-shm`,
      ]) {
        if (!existsSync(source)) continue;
        const destination = join(archiveDirectory, basename(source));
        renameSync(source, destination);
        movedArtifacts.push({ source, destination });
      }
      if (!movedArtifacts.some((artifact) => artifact.source === this.databasePath)) {
        throw new Error("The incompatible provenance ledger disappeared before archival");
      }

      const archive: ProvenanceLedgerArchive = {
        directory: archiveDirectory,
        databaseFile: join(archiveDirectory, basename(this.databasePath)),
        ...(existsSync(join(archiveDirectory, basename(`${this.databasePath}-wal`)))
          ? { walFile: join(archiveDirectory, basename(`${this.databasePath}-wal`)) }
          : {}),
        ...(existsSync(join(archiveDirectory, basename(`${this.databasePath}-shm`)))
          ? { shmFile: join(archiveDirectory, basename(`${this.databasePath}-shm`)) }
          : {}),
      };
      const preparedRebuild = {
        archive,
        replayedEventCount,
        replacementDatabaseFile: temporaryDatabasePath,
        replacementDatabaseSha256:
          this.databaseSha256(temporaryDatabasePath),
        movedArtifacts,
      };
      persistPreparedOutcome(preparedRebuild);
      return preparedRebuild;
    } catch (error) {
      primaryError = error;
      if (movedArtifacts.length > 0) {
        try {
          this.rollbackArchivedArtifacts(movedArtifacts);
        } catch (rollbackError) {
          primaryError = new Error(
            `Provenance ledger replacement and rollback failed; preserved archive: ${this.adjacentPathToken(archiveDirectory)}`,
            { cause: new AggregateError([primaryError, rollbackError]) },
          );
          this.tagOperationFailure(
            "rollback",
            primaryError,
            "Provenance ledger archive operation and rollback failed",
            { archiveToken: this.adjacentPathToken(archiveDirectory) },
          );
        }
      }
      try {
        this.removeTemporaryDatabaseArtifacts(temporaryDatabasePath);
      } catch (cleanupError) {
        throw this.combinedFailure(
          primaryError,
          [cleanupError],
          `Temporary provenance ledger cleanup failed at ${this.adjacentPathToken(temporaryDatabasePath)}`,
          {
            ...(movedArtifacts.length === 0
              ? {}
              : { archiveToken: this.adjacentPathToken(archiveDirectory) }),
            replacementToken: this.adjacentPathToken(temporaryDatabasePath),
          },
        );
      }
      throw this.tagOperationFailure(
        "archive",
        primaryError,
        "Provenance ledger archive preparation failed",
        movedArtifacts.length === 0
          ? { replacementToken: this.adjacentPathToken(temporaryDatabasePath) }
          : {
              archiveToken: this.adjacentPathToken(archiveDirectory),
              replacementToken: this.adjacentPathToken(temporaryDatabasePath),
            },
      );
    }
  }

  private installPreparedReplacement(
    preparedRebuild: PreparedRebuild,
  ): RebuildOutcome {
    let primaryError: unknown;
    try {
      this.installReplacement(
        preparedRebuild.replacementDatabaseFile,
        this.databasePath,
      );
      return {
        archive: preparedRebuild.archive,
        replayedEventCount: preparedRebuild.replayedEventCount,
      };
    } catch (error) {
      primaryError = error;
      try {
        this.rollbackArchivedArtifacts(preparedRebuild.movedArtifacts);
      } catch (rollbackError) {
        primaryError = new Error(
          `Provenance ledger replacement and rollback failed; preserved archive: ${this.adjacentPathToken(preparedRebuild.archive.directory)}`,
          { cause: new AggregateError([primaryError, rollbackError]) },
        );
        this.tagOperationFailure(
          "rollback",
          primaryError,
          "Provenance ledger replacement and rollback failed",
          {
            archiveToken: this.adjacentPathToken(
              preparedRebuild.archive.directory,
            ),
            replacementToken: this.adjacentPathToken(
              preparedRebuild.replacementDatabaseFile,
            ),
          },
        );
      }
      throw this.tagOperationFailure(
        "replacement",
        primaryError,
        "Provenance ledger replacement installation failed",
        {
          archiveToken: this.adjacentPathToken(
            preparedRebuild.archive.directory,
          ),
          replacementToken: this.adjacentPathToken(
            preparedRebuild.replacementDatabaseFile,
          ),
        },
      );
    } finally {
      try {
        this.removeTemporaryDatabaseArtifacts(
          preparedRebuild.replacementDatabaseFile,
        );
      } catch (cleanupError) {
        throw this.combinedFailure(
          primaryError,
          [cleanupError],
          `Temporary provenance ledger cleanup failed at ${this.adjacentPathToken(preparedRebuild.replacementDatabaseFile)}`,
          {
            archiveToken: this.adjacentPathToken(
              preparedRebuild.archive.directory,
            ),
            replacementToken: this.adjacentPathToken(
              preparedRebuild.replacementDatabaseFile,
            ),
          },
        );
      }
    }
  }

  private async resumeInterruptedApply(
    before: ProvenanceLedgerSchemaInspection,
    interruptedApply: InterruptedApply,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    if (interruptedApply.originalState === "missing") {
      const replay = await this.replayReader.read(this.jsonlDirectory);
      if (hasBlockingReplayIssues(replay)) {
        throw new ProvenanceLedgerRecoveryBlockedError(
          this.blockedResult(before, replayInventory(replay)),
        );
      }
      const replayedEventCount = this.createAndReplay(replay);
      const after = this.finishInterruptedApply();
      return this.result({
        mode: "apply",
        status: "created",
        before,
        after,
        replay: replayInventory(replay),
        replayedEventCount,
        catchUpEventCount: 0,
        semanticReindexRequired: replay.events.length > 0,
        recoveryMarkerCleared: true,
      });
    }

    if (interruptedApply.originalState === "unstamped-current") {
      const currentState = this.inspect().state;
      if (currentState === "unstamped-current") {
        this.stampCurrentSchemaVersion();
      } else if (currentState !== "current") {
        throw new Error("Interrupted schema stamp no longer has a compatible ledger");
      }
      const after = this.finishInterruptedApply();
      return this.result({
        mode: "apply",
        status: "stamped",
        before,
        after,
        replay: EMPTY_REPLAY_INVENTORY,
        replayedEventCount: 0,
        catchUpEventCount: 0,
        semanticReindexRequired: false,
        recoveryMarkerCleared: true,
      });
    }

    if (before.state === "incompatible") {
      const replay = await this.replayReader.read(this.jsonlDirectory);
      if (hasBlockingReplayIssues(replay)) {
        throw new ProvenanceLedgerRecoveryBlockedError(
          this.blockedResult(before, replayInventory(replay)),
        );
      }
      return this.rebuildIncompatibleLedger(before, replay);
    }

    if (
      before.state === "missing" &&
      interruptedApply.archive !== undefined &&
      interruptedApply.replacementDatabaseFile !== undefined &&
      interruptedApply.replacementDatabaseSha256 !== undefined
    ) {
      return this.resumePreparedReplacement(before, {
        ...interruptedApply,
        archive: interruptedApply.archive,
        replacementDatabaseFile: interruptedApply.replacementDatabaseFile,
        replacementDatabaseSha256:
          interruptedApply.replacementDatabaseSha256,
      });
    }

    if (before.state !== "current" || interruptedApply.archive === undefined) {
      throw new ProvenanceLedgerRecoveryBlockedError(
        this.blockedResult(before, EMPTY_REPLAY_INVENTORY),
      );
    }

    if (!this.hasValidAdjacentArchive(interruptedApply.archive)) {
      throw new ProvenanceLedgerRecoveryBlockedError(
        this.blockedResult(before, EMPTY_REPLAY_INVENTORY),
      );
    }

    const catchUp = await this.replayCatchUp(
      before,
      interruptedApply.archive,
      interruptedApply.replayedEventCount,
    );
    const after = this.finishInterruptedApply();
    return this.result({
      mode: "apply",
      status: "rebuilt",
      before,
      after,
      replay: replayInventory(catchUp.replay),
      replayedEventCount: interruptedApply.replayedEventCount,
      catchUpEventCount: catchUp.insertedEventCount,
      archive: interruptedApply.archive,
      semanticReindexRequired:
        interruptedApply.replayedEventCount + catchUp.insertedEventCount > 0,
      recoveryMarkerCleared: true,
    });
  }

  private async resumePreparedReplacement(
    before: ProvenanceLedgerSchemaInspection,
    interruptedApply: InterruptedApply & {
      archive: ProvenanceLedgerArchive;
      replacementDatabaseFile: string;
      replacementDatabaseSha256: string;
    },
  ): Promise<ProvenanceLedgerRecoveryResult> {
    if (!this.hasValidPreparedReplacement(interruptedApply)) {
      throw new ProvenanceLedgerRecoveryBlockedError(
        this.blockedResult(before, EMPTY_REPLAY_INVENTORY),
      );
    }
    await this.withRecoveryMarker(before, undefined, async () => {
      const evidence = {
        archiveToken: this.adjacentPathToken(interruptedApply.archive.directory),
        replacementToken: this.adjacentPathToken(
          interruptedApply.replacementDatabaseFile,
        ),
      };
      try {
        this.installReplacement(
          interruptedApply.replacementDatabaseFile,
          this.databasePath,
        );
      } catch (error) {
        throw this.tagOperationFailure(
          "replacement",
          error,
          "Prepared provenance ledger replacement installation failed",
          evidence,
        );
      }
      try {
        this.removeTemporaryDatabaseArtifacts(
          interruptedApply.replacementDatabaseFile,
        );
      } catch (error) {
        throw this.tagOperationFailure(
          "cleanup",
          error,
          "Prepared provenance ledger replacement cleanup failed",
          evidence,
        );
      }
      this.testHooks.afterReplacementInstall?.();
    });
    const catchUp = await this.replayCatchUp(
      before,
      interruptedApply.archive,
      interruptedApply.replayedEventCount,
    );
    const after = this.finishInterruptedApply();
    return this.result({
      mode: "apply",
      status: "rebuilt",
      before,
      after,
      replay: replayInventory(catchUp.replay),
      replayedEventCount: interruptedApply.replayedEventCount,
      catchUpEventCount: catchUp.insertedEventCount,
      archive: interruptedApply.archive,
      semanticReindexRequired:
        interruptedApply.replayedEventCount + catchUp.insertedEventCount > 0,
      recoveryMarkerCleared: true,
    });
  }

  private async applyCreate(
    before: ProvenanceLedgerSchemaInspection,
    replay: ValidatedProvenanceJsonlReplay,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const interruptedApply: InterruptedApply = {
      schemaVersion: 1,
      originalState: "missing",
      replayedEventCount: 0,
    };
    this.writeInterruptedApply(interruptedApply, true);
    const replayedEventCount = this.createAndReplay(replay);
    const after = this.finishInterruptedApply();
    return this.result({
      mode: "apply",
      status: "created",
      before,
      after,
      replay: replayInventory(replay),
      replayedEventCount,
      catchUpEventCount: 0,
      semanticReindexRequired: replayedEventCount > 0,
      recoveryMarkerCleared: true,
    });
  }

  private async applyStamp(
    before: ProvenanceLedgerSchemaInspection,
  ): Promise<ProvenanceLedgerRecoveryResult> {
    const interruptedApply: InterruptedApply = {
      schemaVersion: 1,
      originalState: "unstamped-current",
      replayedEventCount: 0,
    };
    this.writeInterruptedApply(interruptedApply, true);
    this.stampCurrentSchemaVersion();
    const after = this.finishInterruptedApply();
    return this.result({
      mode: "apply",
      status: "stamped",
      before,
      after,
      replay: EMPTY_REPLAY_INVENTORY,
      replayedEventCount: 0,
      catchUpEventCount: 0,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
    });
  }

  private async replayCatchUp(
    before: ProvenanceLedgerSchemaInspection,
    archive: ProvenanceLedgerArchive,
    replayedEventCount: number,
  ): Promise<{
    replay: ValidatedProvenanceJsonlReplay;
    insertedEventCount: number;
  }> {
    try {
      const replay = await this.replayReader.read(this.jsonlDirectory);
      if (hasBlockingReplayIssues(replay)) {
        throw new ProvenanceLedgerRecoveryBlockedError(
          this.blockedResult(before, replayInventory(replay), archive, replayedEventCount),
        );
      }
      return {
        replay,
        insertedEventCount: this.replayIntoCurrentLedger(replay),
      };
    } catch (error) {
      if (
        error instanceof ProvenanceLedgerRecoveryBlockedError ||
        error instanceof ProvenanceLedgerRecoveryOperationError
      ) {
        throw error;
      }
      throw this.tagOperationFailure(
        "catch-up",
        error,
        "Provenance ledger catch-up replay failed",
        { archiveToken: this.adjacentPathToken(archive.directory) },
      );
    }
  }

  private async withRecoveryMarker<T>(
    before: ProvenanceLedgerSchemaInspection,
    replay: ValidatedProvenanceJsonlReplay | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const markerPath = provenanceLedgerRecoveryMarkerPath(this.databasePath);
    let markerDescriptor: number;
    try {
      markerDescriptor = openSync(markerPath, "wx");
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        return this.blockOrThrow(
          "apply",
          before,
          replay === undefined ? EMPTY_REPLAY_INVENTORY : replayInventory(replay),
          false,
        ) as never;
      }
      throw this.tagOperationFailure(
        "recovery-marker",
        error,
        "Provenance recovery marker acquisition failed",
        {
          markerToken: this.adjacentPathToken(markerPath),
          markerPresent: existsSync(markerPath),
        },
      );
    }

    let operationError: unknown;
    try {
      try {
        const markerContents = JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        });
        if (this.testHooks.writeRecoveryMarker === undefined) {
          writeFileSync(markerDescriptor, markerContents, "utf8");
        } else {
          this.testHooks.writeRecoveryMarker(markerDescriptor, markerContents);
        }
      } catch (error) {
        operationError = this.tagOperationFailure(
          "recovery-marker",
          error,
          "Provenance recovery marker write failed",
          {
            markerToken: this.adjacentPathToken(markerPath),
            markerPresent: existsSync(markerPath),
          },
        );
        throw operationError;
      }

      try {
        return await operation();
      } catch (error) {
        operationError = error;
        throw error;
      }
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        if (this.testHooks.closeRecoveryMarker === undefined) {
          closeSync(markerDescriptor);
        } else {
          this.testHooks.closeRecoveryMarker(markerDescriptor);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (this.testHooks.removeRecoveryMarker === undefined) {
          rmSync(markerPath, { force: true });
        } else {
          this.testHooks.removeRecoveryMarker(markerPath);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        const markerRemains = existsSync(markerPath);
        throw this.combinedFailure(
          operationError,
          cleanupErrors,
          markerRemains
            ? `Provenance recovery marker cleanup failed. Manually remove ${this.adjacentPathToken(markerPath)} after confirming no recovery process is active.`
            : "Provenance recovery marker cleanup failed after the exact marker was removed",
          {
            markerToken: this.adjacentPathToken(markerPath),
            markerPresent: markerRemains,
          },
        );
      }
    }
  }

  private interruptedApplyPath(): string {
    return `${provenanceLedgerRecoveryMarkerPath(this.databasePath)}.interrupted`;
  }

  private readInterruptedApply(): InterruptedApply | undefined {
    const interruptedApplyPath = this.interruptedApplyPath();
    if (!existsSync(interruptedApplyPath)) return undefined;
    return InterruptedApplySchema.parse(
      JSON.parse(readFileSync(interruptedApplyPath, "utf8")),
    );
  }

  private writeInterruptedApply(
    interruptedApply: InterruptedApply,
    exclusive = false,
  ): void {
    const parsed = InterruptedApplySchema.parse(interruptedApply);
    const interruptedApplyPath = this.interruptedApplyPath();
    if (exclusive) {
      writeFileSync(interruptedApplyPath, JSON.stringify(parsed), {
        encoding: "utf8",
        flag: "wx",
      });
      return;
    }
    const temporaryPath = `${interruptedApplyPath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(parsed), {
      encoding: "utf8",
      flag: "wx",
    });
    let renameError: unknown;
    try {
      renameSync(temporaryPath, interruptedApplyPath);
    } catch (error) {
      renameError = error;
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw this.combinedFailure(
        renameError,
        [cleanupError],
        `Interrupted recovery stamp cleanup failed at ${this.adjacentPathToken(temporaryPath)}`,
      );
    }
    if (renameError !== undefined) throw renameError;
  }

  private finishInterruptedApply(): ProvenanceLedgerSchemaInspection {
    let after: ProvenanceLedgerSchemaInspection;
    try {
      this.testHooks.beforeFinalInspection?.();
      after = this.requireCurrentInspection();
    } catch (error) {
      throw this.tagOperationFailure(
        "final-inspection",
        error,
        "Final provenance ledger inspection failed; interrupted recovery state was preserved",
      );
    }
    const interruptedApplyPath = this.interruptedApplyPath();
    try {
      if (this.testHooks.removeInterruptedApply === undefined) {
        rmSync(interruptedApplyPath);
      } else {
        this.testHooks.removeInterruptedApply(interruptedApplyPath);
      }
    } catch (error) {
      throw this.tagOperationFailure(
        "cleanup",
        error,
        "Interrupted recovery descriptor cleanup failed",
        { markerToken: this.adjacentPathToken(interruptedApplyPath) },
      );
    }
    return after;
  }

  private blockedResult(
    before: ProvenanceLedgerSchemaInspection,
    replay: ProvenanceJsonlReplayInventory,
    archive?: ProvenanceLedgerArchive,
    replayedEventCount = 0,
  ): ProvenanceLedgerRecoveryResult {
    return this.result({
      mode: "apply",
      status: "blocked",
      before,
      after: this.inspect(),
      replay,
      replayedEventCount,
      catchUpEventCount: 0,
      ...(archive === undefined ? {} : { archive }),
      semanticReindexRequired: replayedEventCount > 0,
      recoveryMarkerCleared: !existsSync(
        provenanceLedgerRecoveryMarkerPath(this.databasePath),
      ),
    });
  }

  private createAndReplay(replay: ValidatedProvenanceJsonlReplay): number {
    return this.replayIntoLedger(this.databasePath, replay);
  }

  private writeReplayDatabase(
    databasePath: string,
    replay: ValidatedProvenanceJsonlReplay,
  ): number {
    return this.replayIntoLedger(databasePath, replay);
  }

  private replayIntoCurrentLedger(
    replay: ValidatedProvenanceJsonlReplay,
  ): number {
    this.schemaInspector.assertCompatible(this.databasePath);
    return this.replayIntoLedger(this.databasePath, replay);
  }

  private replayIntoLedger(
    databasePath: string,
    replay: ValidatedProvenanceJsonlReplay,
  ): number {
    const writer = new ProvenanceLedgerWriter(databasePath);
    let insertedEventCount = 0;
    let primaryError: unknown;
    try {
      for (const event of replay.events) {
        if (writer.insertIfAbsent(event).inserted) insertedEventCount += 1;
        this.testHooks.afterReplayInsert?.(insertedEventCount, databasePath);
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        if (this.testHooks.closeReplayWriter === undefined) {
          writer.close();
        } else {
          this.testHooks.closeReplayWriter(writer);
        }
      } catch (closeError) {
        throw this.combinedFailure(
          primaryError,
          [closeError],
          "Provenance replay writer close failed",
        );
      }
    }
    return insertedEventCount;
  }

  private stampCurrentSchemaVersion(): void {
    this.schemaInspector.assertCompatible(this.databasePath);
    const database = new Database(this.databasePath, { fileMustExist: true });
    let primaryError: unknown;
    try {
      database.pragma("busy_timeout = 5000");
      database.transaction(() => {
        database.pragma("user_version = 1");
      })();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        if (this.testHooks.closeStampDatabase === undefined) {
          database.close();
        } else {
          this.testHooks.closeStampDatabase(database);
        }
      } catch (closeError) {
        throw this.combinedFailure(
          primaryError,
          [closeError],
          "Provenance schema stamp database close failed",
        );
      }
    }
    this.testHooks.afterStampClose?.();
  }

  private requireCurrentInspection(): ProvenanceLedgerSchemaInspection {
    const inspection = this.inspect();
    if (inspection.state !== "current" || inspection.recoveryMarkerPresent) {
      throw new Error("Recovered provenance ledger did not inspect as current");
    }
    return inspection;
  }

  private hasValidPreparedReplacement(
    interruptedApply: InterruptedApply & {
      archive: ProvenanceLedgerArchive;
      replacementDatabaseFile: string;
      replacementDatabaseSha256: string;
    },
  ): boolean {
    const archiveToken = this.adjacentArchiveToken(interruptedApply.archive);
    if (archiveToken === undefined) return false;
    const expectedReplacement = join(
      dirname(this.databasePath),
      `.${basename(this.databasePath)}.${archiveToken}.rebuild`,
    );
    if (
      interruptedApply.replacementDatabaseFile !== expectedReplacement ||
      !this.isRegularFile(expectedReplacement) ||
      this.databaseSha256(expectedReplacement) !==
        interruptedApply.replacementDatabaseSha256
    ) {
      return false;
    }
    const inspection = this.schemaInspector.inspect(expectedReplacement);
    return (
      inspection.state === "current" && !inspection.recoveryMarkerPresent
    );
  }

  private hasValidAdjacentArchive(archive: ProvenanceLedgerArchive): boolean {
    return this.adjacentArchiveToken(archive) !== undefined;
  }

  private adjacentArchiveToken(
    archive: ProvenanceLedgerArchive,
  ): string | undefined {
    const parentDirectory = dirname(this.databasePath);
    const databaseName = basename(this.databasePath);
    const archivePrefix = `${databaseName}.archive-`;
    const archiveName = basename(archive.directory);
    if (
      dirname(archive.directory) !== parentDirectory ||
      !archiveName.startsWith(archivePrefix)
    ) {
      return undefined;
    }
    const archiveToken = archiveName.slice(archivePrefix.length);
    if (
      !/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        archiveToken,
      ) ||
      archive.directory !==
        join(parentDirectory, `${databaseName}.archive-${archiveToken}`) ||
      !this.isDirectory(archive.directory) ||
      archive.databaseFile !== join(archive.directory, databaseName) ||
      !this.isRegularFile(archive.databaseFile)
    ) {
      return undefined;
    }
    for (const [archiveFile, expectedName] of [
      [archive.walFile, basename(`${this.databasePath}-wal`)],
      [archive.shmFile, basename(`${this.databasePath}-shm`)],
    ] as const) {
      if (
        archiveFile !== undefined &&
        (archiveFile !== join(archive.directory, expectedName) ||
          !this.isRegularFile(archiveFile))
      ) {
        return undefined;
      }
    }
    return archiveToken;
  }

  private isDirectory(path: string): boolean {
    try {
      const stats = lstatSync(path);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private isRegularFile(path: string): boolean {
    try {
      const stats = lstatSync(path);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private databaseSha256(databasePath: string): string {
    return createHash("sha256")
      .update(readFileSync(databasePath))
      .digest("hex");
  }

  private rollbackArchivedArtifacts(
    movedArtifacts: Array<{ source: string; destination: string }>,
  ): void {
    const rollbackErrors: unknown[] = [];
    for (const artifact of movedArtifacts) {
      if (!existsSync(artifact.destination)) {
        rollbackErrors.push(
          new Error(`Archived artifact is missing at ${this.adjacentPathToken(artifact.destination)}`),
        );
      }
      if (existsSync(artifact.source)) {
        rollbackErrors.push(
          new Error(`Rollback source collision at ${this.adjacentPathToken(artifact.source)}`),
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(rollbackErrors, "Archived provenance artifacts cannot be restored safely");
    }

    for (const artifact of [...movedArtifacts].reverse()) {
      try {
        if (this.testHooks.restoreArchivedArtifact === undefined) {
          renameSync(artifact.destination, artifact.source);
        } else {
          this.testHooks.restoreArchivedArtifact(
            artifact.destination,
            artifact.source,
          );
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const artifact of movedArtifacts) {
      if (!existsSync(artifact.source) || existsSync(artifact.destination)) {
        rollbackErrors.push(
          new Error(`Archived artifact was not restored from ${this.adjacentPathToken(artifact.destination)}`),
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(rollbackErrors, "Archived provenance artifact rollback was incomplete");
    }
  }

  private removeTemporaryDatabaseArtifacts(databasePath: string): void {
    const cleanupErrors: unknown[] = [];
    for (const temporaryPath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      try {
        if (this.testHooks.removeTemporaryArtifact === undefined) {
          rmSync(temporaryPath, { force: true });
        } else {
          this.testHooks.removeTemporaryArtifact(temporaryPath);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "One or more temporary provenance ledger artifacts could not be removed",
      );
    }
  }

  private adjacentPathToken(path: string): string {
    return `<ledger-adjacent>/${basename(path)}`;
  }

  private combinedFailure(
    primaryError: unknown,
    additionalErrors: unknown[],
    message: string,
    evidence: ProvenanceLedgerRecoveryOperationEvidence = {},
  ): ProvenanceLedgerRecoveryCleanupError {
    const errors = primaryError === undefined
      ? additionalErrors
      : [primaryError, ...additionalErrors];
    const inheritedEvidence = primaryError instanceof ProvenanceLedgerRecoveryOperationError
      ? primaryError.evidence
      : this.operationContext(primaryError)?.evidence ?? {};
    const trustedEvidence = { ...inheritedEvidence, ...evidence };
    return new ProvenanceLedgerRecoveryCleanupError(
      trustedEvidence.archiveToken === undefined
        ? message
        : `${message}; preserved archive: ${trustedEvidence.archiveToken}`,
      errors,
      trustedEvidence,
    );
  }

  private operationFailure(
    stage: ProvenanceLedgerRecoveryOperationStage,
    cause: unknown,
    message: string,
    evidence: ProvenanceLedgerRecoveryOperationEvidence = {},
  ): ProvenanceLedgerRecoveryOperationError {
    return new ProvenanceLedgerRecoveryOperationError(
      stage,
      message,
      evidence,
      { cause },
    );
  }

  private tagOperationFailure(
    stage: ProvenanceLedgerRecoveryOperationStage,
    error: unknown,
    message: string,
    evidence: ProvenanceLedgerRecoveryOperationEvidence = {},
  ): unknown {
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      !recoveryOperationContexts.has(error)
    ) {
      recoveryOperationContexts.set(error, { stage, message, evidence });
    }
    return error;
  }

  private operationContext(
    error: unknown,
  ): ProvenanceLedgerRecoveryOperationContext | undefined {
    if (
      error === null ||
      (typeof error !== "object" && typeof error !== "function")
    ) {
      return undefined;
    }
    return recoveryOperationContexts.get(error);
  }

  private blockOrThrow(
    mode: "dry-run" | "apply",
    before: ProvenanceLedgerSchemaInspection,
    replay: ProvenanceJsonlReplayInventory,
    recoveryMarkerCleared: boolean,
  ): ProvenanceLedgerRecoveryResult {
    const result = this.result({
      mode,
      status: "blocked",
      before,
      replay,
      replayedEventCount: 0,
      catchUpEventCount: 0,
      semanticReindexRequired: false,
      recoveryMarkerCleared,
    });
    if (mode === "apply") {
      throw new ProvenanceLedgerRecoveryBlockedError(result);
    }
    return result;
  }

  private result(
    result: Omit<
      ProvenanceLedgerRecoveryResult,
      "schemaVersion" | "nextAction"
    >,
  ): ProvenanceLedgerRecoveryResult {
    const replayDisposition = hasBlockingReplayIssues(result.replay)
      ? "blocked"
      : hasSkippedReplayRecords(result.replay)
        ? "partial"
        : "complete";
    const nextAction = deriveProvenanceLedgerRecoveryNextAction(
      result.status,
      result.semanticReindexRequired,
      replayDisposition,
      result.before.recoveryMarkerPresent,
      result.recoveryMarkerCleared,
    );
    return ProvenanceLedgerRecoveryResultSchema.parse({
      schemaVersion: 1,
      ...result,
      nextAction,
    });
  }
}

function replayInventory(
  replay: ValidatedProvenanceJsonlReplay,
): ProvenanceJsonlReplayInventory {
  const { events: _events, ...inventory } = replay;
  return ProvenanceJsonlReplayInventorySchema.parse(inventory);
}

export function hasBlockingReplayIssues(
  replay: ProvenanceJsonlReplayInventory,
): boolean {
  return replay.disposition === "blocked";
}

export function hasSkippedReplayRecords(
  replay: ProvenanceJsonlReplayInventory,
): boolean {
  return replay.disposition === "partial";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
