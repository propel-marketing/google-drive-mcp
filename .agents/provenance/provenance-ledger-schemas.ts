import { z } from "zod";

import {
  ProvenanceRecordReceiptSchema,
  RedactedProvenanceEventSchema,
} from "./provenance-schemas.js";

export const ProvenanceLedgerSchemaStateSchema = z.enum([
  "missing",
  "current",
  "unstamped-current",
  "incompatible",
]);

export const ProvenanceLedgerSchemaReasonCodeSchema = z.enum([
  "database-missing",
  "recovery-marker-present",
  "unsupported-user-version",
  "required-table-missing",
  "required-column-missing",
]);

export const ProvenanceLedgerTableInspectionSchema = z.object({
  tableName: z.enum(["provenance_events", "provenance_embeddings"]),
  requiredColumns: z.array(z.string().min(1)),
  observedColumns: z.array(z.string().min(1)),
  missingColumns: z.array(z.string().min(1)),
});

export const ProvenanceLedgerSchemaInspectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    databasePath: z.string().min(1),
    databaseExists: z.boolean(),
    recoveryMarkerPresent: z.boolean(),
    expectedUserVersion: z.literal(1),
    observedUserVersion: z.number().int().nonnegative().optional(),
    state: ProvenanceLedgerSchemaStateSchema,
    tables: z.array(ProvenanceLedgerTableInspectionSchema),
    reasonCodes: z.array(ProvenanceLedgerSchemaReasonCodeSchema),
  })
  .superRefine((inspection, context) => {
    const inspectedTableNames = new Set(
      inspection.tables.map((table) => table.tableName),
    );
    const hasAllRequiredColumns =
      inspection.tables.length === 2 &&
      inspectedTableNames.has("provenance_events") &&
      inspectedTableNames.has("provenance_embeddings") &&
      inspection.tables.every((table) => table.missingColumns.length === 0);

    if (
      inspection.state === "missing" &&
      (inspection.databaseExists || inspection.observedUserVersion !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "missing ledgers require an absent database and no observed user version",
      });
    }
    if (
      inspection.state === "current" &&
      (!inspection.databaseExists ||
        inspection.observedUserVersion !== 1 ||
        !hasAllRequiredColumns)
    ) {
      context.addIssue({
        code: "custom",
        message: "current ledgers require version 1 and all required columns",
      });
    }
    if (
      inspection.state === "unstamped-current" &&
      (!inspection.databaseExists ||
        inspection.observedUserVersion !== 0 ||
        !hasAllRequiredColumns)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "unstamped-current ledgers require version 0 and all required columns",
      });
    }
    if (
      inspection.state === "incompatible" &&
      !inspection.reasonCodes.some((reason) => reason !== "database-missing")
    ) {
      context.addIssue({
        code: "custom",
        message: "incompatible ledgers require a compatibility reason",
      });
    }
  });

export const ProvenanceJsonlReplayDispositionSchema = z.enum([
  "complete",
  "partial",
  "blocked",
]);

export type ProvenanceJsonlReplayDisposition = z.infer<
  typeof ProvenanceJsonlReplayDispositionSchema
>;

export const ProvenanceJsonlReplayIssueDispositionSchema = z.enum([
  "skipped",
  "blocking",
]);

export type ProvenanceJsonlReplayIssueDisposition = z.infer<
  typeof ProvenanceJsonlReplayIssueDispositionSchema
>;

export const ProvenanceJsonlReplayIssueSchema = z.object({
  relativePath: z.string().min(1),
  lineNumber: z.number().int().positive(),
  disposition: ProvenanceJsonlReplayIssueDispositionSchema,
  code: z.enum([
    "invalid-json",
    "invalid-redacted-event",
    "conflicting-event-id",
  ]),
  sanitizedMessage: z.string().min(1).max(512),
}).superRefine((issue, context) => {
  const expectedDisposition =
    issue.code === "conflicting-event-id" ? "blocking" : "skipped";
  if (issue.disposition !== expectedDisposition) {
    context.addIssue({
      code: "custom",
      path: ["disposition"],
      message: `replay issue disposition must be ${expectedDisposition}`,
    });
  }
});

/** Maximum safe replay diagnostics retained for CLI and machine JSON output. */
export const PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT = 100;

const ProvenanceJsonlReplayInventoryObjectSchema = z
  .object({
    jsonlFileCount: z.number().int().nonnegative(),
    nonBlankLineCount: z.number().int().nonnegative(),
    validEventCount: z.number().int().nonnegative(),
    duplicateEventCount: z.number().int().nonnegative(),
    conflictingEventCount: z.number().int().nonnegative(),
    invalidRecordCount: z.number().int().nonnegative(),
    disposition: ProvenanceJsonlReplayDispositionSchema.optional(),
    skippedIssueCount: z.number().int().nonnegative().optional(),
    blockingIssueCount: z.number().int().nonnegative().optional(),
    issueCount: z.number().int().nonnegative().optional(),
    issuesShown: z.number().int().nonnegative().optional(),
    issuesTruncated: z.boolean().optional(),
    issues: z
      .array(ProvenanceJsonlReplayIssueSchema)
      .max(PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT),
  })
  .superRefine((inventory, context) => {
    const invalidIssueCount = inventory.issues.filter(
      (issue) =>
        issue.code === "invalid-json" ||
        issue.code === "invalid-redacted-event",
    ).length;
    const conflictingIssueCount = inventory.issues.filter(
      (issue) => issue.code === "conflicting-event-id",
    ).length;

    if (invalidIssueCount > inventory.invalidRecordCount) {
      context.addIssue({
        code: "custom",
        message: "retained invalid issues cannot exceed invalidRecordCount",
      });
    }
    if (conflictingIssueCount > inventory.conflictingEventCount) {
      context.addIssue({
        code: "custom",
        message:
          "retained conflicting issues cannot exceed conflictingEventCount",
      });
    }
  });

function deriveReplayIssueSummary<
  T extends {
    invalidRecordCount: number;
    conflictingEventCount: number;
    issues: ProvenanceJsonlReplayIssue[];
  },
>(inventory: T) {
  const issueCount =
    inventory.invalidRecordCount + inventory.conflictingEventCount;
  const issuesShown = inventory.issues.length;
  const disposition = deriveProvenanceJsonlReplayDisposition(
    inventory.invalidRecordCount,
    inventory.conflictingEventCount,
  );
  return {
    ...inventory,
    disposition,
    skippedIssueCount: inventory.invalidRecordCount,
    blockingIssueCount: inventory.conflictingEventCount,
    issueCount,
    issuesShown,
    issuesTruncated: issueCount > issuesShown,
  };
}

export function deriveProvenanceJsonlReplayDisposition(
  invalidRecordCount: number,
  conflictingEventCount: number,
): ProvenanceJsonlReplayDisposition {
  if (conflictingEventCount > 0) return "blocked";
  if (invalidRecordCount > 0) return "partial";
  return "complete";
}

export const ProvenanceJsonlReplayInventorySchema =
  ProvenanceJsonlReplayInventoryObjectSchema.transform(
    deriveReplayIssueSummary,
  );

export const ValidatedProvenanceJsonlReplaySchema =
  ProvenanceJsonlReplayInventoryObjectSchema.safeExtend({
    events: z.array(RedactedProvenanceEventSchema),
  }).superRefine((replay, context) => {
    if (replay.validEventCount !== replay.events.length) {
      context.addIssue({
        code: "custom",
        message: "validEventCount must equal events.length",
      });
    }
  }).transform(deriveReplayIssueSummary);

export const ProvenanceLedgerRecoveryRequestSchema = z.object({
  mode: z.enum(["dry-run", "apply"]).default("dry-run"),
});

export const ProvenanceLedgerArchiveSchema = z.object({
  directory: z.string().min(1),
  databaseFile: z.string().min(1),
  walFile: z.string().min(1).optional(),
  shmFile: z.string().min(1).optional(),
});

export const ProvenanceLedgerRecoveryStatusSchema = z.enum([
  "current",
  "would-create",
  "would-stamp",
  "would-rebuild",
  "blocked",
  "created",
  "stamped",
  "rebuilt",
]);

export type ProvenanceLedgerRecoveryStatus = z.infer<
  typeof ProvenanceLedgerRecoveryStatusSchema
>;

export const ProvenanceLedgerRecoveryNextActionSchema = z.discriminatedUnion(
  "code",
  [
    z
      .object({
        code: z.literal("none"),
        message: z.literal("No recovery action is required."),
      })
      .strict(),
    z
      .object({
        code: z.literal("apply-recovery"),
        message: z.literal("Apply the previewed ledger recovery explicitly."),
        command: z.literal("recover-ledger --apply"),
      })
      .strict(),
    z
      .object({
        code: z.literal("correct-replay-evidence"),
        message: z.literal(
          "Correct only the listed relative replay evidence locations, then rerun the recovery preview.",
        ),
        command: z.literal("recover-ledger"),
      })
      .strict(),
    z
      .object({
        code: z.literal("wait-inspect-retry"),
        message: z.literal(
          "Wait for the active recovery to finish, inspect ledger status, then retry without deleting recovery markers.",
        ),
        command: z.literal("ledger-status"),
      })
      .strict(),
    z
      .object({
        code: z.literal("resume-interrupted-recovery"),
        message: z.literal("Resume the interrupted ledger recovery explicitly."),
        command: z.literal("recover-ledger --apply"),
      })
      .strict(),
    z
      .object({
        code: z.literal("review-skipped-replay-evidence"),
        message: z.literal(
          "Structured recovery completed with invalid replay records excluded and preserved; review the listed relative evidence before running semantic indexing explicitly.",
        ),
      })
      .strict(),
    z
      .object({
        code: z.literal("run-semantic-index"),
        message: z.literal(
          "Structured recovery is complete; run semantic indexing explicitly.",
        ),
        command: z.literal("index"),
      })
      .strict(),
  ],
);

export type ProvenanceLedgerRecoveryNextAction = z.infer<
  typeof ProvenanceLedgerRecoveryNextActionSchema
>;

export function deriveProvenanceLedgerRecoveryNextAction(
  status: ProvenanceLedgerRecoveryStatus,
  semanticReindexRequired: boolean,
  replayDisposition: ProvenanceJsonlReplayDisposition,
  recoveryMarkerPresent: boolean,
  recoveryMarkerCleared: boolean,
): ProvenanceLedgerRecoveryNextAction {
  if (
    status === "would-create" ||
    status === "would-stamp" ||
    status === "would-rebuild"
  ) {
    return ProvenanceLedgerRecoveryNextActionSchema.parse({
      code: "apply-recovery",
      message: "Apply the previewed ledger recovery explicitly.",
      command: "recover-ledger --apply",
    });
  }
  if (status === "blocked") {
    if (replayDisposition === "blocked") {
      return ProvenanceLedgerRecoveryNextActionSchema.parse({
        code: "correct-replay-evidence",
        message:
          "Correct only the listed relative replay evidence locations, then rerun the recovery preview.",
        command: "recover-ledger",
      });
    }
    if (recoveryMarkerPresent || !recoveryMarkerCleared) {
      return ProvenanceLedgerRecoveryNextActionSchema.parse({
        code: "wait-inspect-retry",
        message:
          "Wait for the active recovery to finish, inspect ledger status, then retry without deleting recovery markers.",
        command: "ledger-status",
      });
    }
    return ProvenanceLedgerRecoveryNextActionSchema.parse({
      code: "resume-interrupted-recovery",
      message: "Resume the interrupted ledger recovery explicitly.",
      command: "recover-ledger --apply",
    });
  }
  if (replayDisposition === "partial") {
    return ProvenanceLedgerRecoveryNextActionSchema.parse({
      code: "review-skipped-replay-evidence",
      message:
        "Structured recovery completed with invalid replay records excluded and preserved; review the listed relative evidence before running semantic indexing explicitly.",
    });
  }
  if (semanticReindexRequired) {
    return ProvenanceLedgerRecoveryNextActionSchema.parse({
      code: "run-semantic-index",
      message:
        "Structured recovery is complete; run semantic indexing explicitly.",
      command: "index",
    });
  }
  return ProvenanceLedgerRecoveryNextActionSchema.parse({
    code: "none",
    message: "No recovery action is required.",
  });
}

export const ProvenanceLedgerRecoveryResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["dry-run", "apply"]),
    status: ProvenanceLedgerRecoveryStatusSchema,
    before: ProvenanceLedgerSchemaInspectionSchema,
    after: ProvenanceLedgerSchemaInspectionSchema.optional(),
    replay: ProvenanceJsonlReplayInventorySchema,
    replayedEventCount: z.number().int().nonnegative(),
    catchUpEventCount: z.number().int().nonnegative(),
    archive: ProvenanceLedgerArchiveSchema.optional(),
    semanticReindexRequired: z.boolean(),
    recoveryMarkerCleared: z.boolean(),
    nextAction: ProvenanceLedgerRecoveryNextActionSchema,
  })
  .superRefine((result, context) => {
    const replayBlocksApply = result.replay.disposition === "blocked";
    if (
      result.mode === "apply" &&
      replayBlocksApply &&
      result.status !== "blocked"
    ) {
      context.addIssue({
        code: "custom",
        message: "apply must be blocked by conflicting replay input",
      });
    }
    if (
      result.status === "rebuilt" &&
      (result.archive === undefined ||
        result.after?.state !== "current" ||
        result.after.recoveryMarkerPresent ||
        !result.recoveryMarkerCleared ||
        result.replay.disposition === "blocked")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "rebuilt results require an archive, current after-state, cleared marker, and non-blocking replay",
      });
    }
    const expectedNextAction = deriveProvenanceLedgerRecoveryNextAction(
      result.status,
      result.semanticReindexRequired,
      result.replay.disposition,
      result.before.recoveryMarkerPresent,
      result.recoveryMarkerCleared,
    );
    if (result.nextAction.code !== expectedNextAction.code) {
      context.addIssue({
        code: "custom",
        path: ["nextAction", "code"],
        message: `nextAction must be ${expectedNextAction.code} for this recovery result`,
      });
    }
  });

export const ProvenanceReplayInsertResultSchema = z.object({
  inserted: z.boolean(),
  receipt: ProvenanceRecordReceiptSchema.optional(),
});

export const ProvenanceLedgerStatusCliOptionsSchema = z.object({
  requireReady: z.boolean().default(false),
});

export const ProvenanceLedgerRecoveryCliOptionsSchema = z.object({
  apply: z.boolean().default(false),
});

export const ProvenanceLedgerInitInvocationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string().min(1)),
  cwd: z.string().min(1),
});

export type ProvenanceLedgerSchemaState = z.infer<
  typeof ProvenanceLedgerSchemaStateSchema
>;
export type ProvenanceLedgerSchemaReasonCode = z.infer<
  typeof ProvenanceLedgerSchemaReasonCodeSchema
>;
export type ProvenanceLedgerTableInspection = z.infer<
  typeof ProvenanceLedgerTableInspectionSchema
>;
export type ProvenanceLedgerSchemaInspection = z.infer<
  typeof ProvenanceLedgerSchemaInspectionSchema
>;
export type ProvenanceJsonlReplayIssue = z.infer<
  typeof ProvenanceJsonlReplayIssueSchema
>;
export type ProvenanceJsonlReplayInventory = z.infer<
  typeof ProvenanceJsonlReplayInventorySchema
>;
export type ValidatedProvenanceJsonlReplay = z.infer<
  typeof ValidatedProvenanceJsonlReplaySchema
>;
export type ProvenanceLedgerRecoveryRequest = z.infer<
  typeof ProvenanceLedgerRecoveryRequestSchema
>;
export type ProvenanceLedgerArchive = z.infer<
  typeof ProvenanceLedgerArchiveSchema
>;
export type ProvenanceLedgerRecoveryResult = z.infer<
  typeof ProvenanceLedgerRecoveryResultSchema
>;
export type ProvenanceReplayInsertResult = z.infer<
  typeof ProvenanceReplayInsertResultSchema
>;
export type ProvenanceLedgerStatusCliOptions = z.infer<
  typeof ProvenanceLedgerStatusCliOptionsSchema
>;
export type ProvenanceLedgerRecoveryCliOptions = z.infer<
  typeof ProvenanceLedgerRecoveryCliOptionsSchema
>;
export type ProvenanceLedgerInitInvocation = z.infer<
  typeof ProvenanceLedgerInitInvocationSchema
>;
