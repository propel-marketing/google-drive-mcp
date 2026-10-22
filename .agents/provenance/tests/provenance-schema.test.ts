import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import type { z } from "zod";

import {
  createCurrentProvenanceLedgerSchema,
  PROVENANCE_LEDGER_REQUIRED_COLUMNS,
  PROVENANCE_LEDGER_USER_VERSION,
  ProvenanceLedgerSchemaInspector,
} from "../provenance-ledger-definition.js";
import {
  deriveProvenanceLedgerRecoveryNextAction,
  PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT,
  ProvenanceJsonlReplayDispositionSchema,
  ProvenanceJsonlReplayInventorySchema,
  ProvenanceJsonlReplayIssueDispositionSchema,
  ProvenanceJsonlReplayIssueSchema,
  ProvenanceLedgerArchiveSchema,
  ProvenanceLedgerInitInvocationSchema,
  ProvenanceLedgerRecoveryCliOptionsSchema,
  ProvenanceLedgerRecoveryNextActionSchema,
  ProvenanceLedgerRecoveryRequestSchema,
  ProvenanceLedgerRecoveryResultSchema,
  ProvenanceLedgerRecoveryStatusSchema,
  ProvenanceLedgerSchemaInspectionSchema,
  ProvenanceLedgerSchemaReasonCodeSchema,
  ProvenanceLedgerSchemaStateSchema,
  ProvenanceLedgerStatusCliOptionsSchema,
  ProvenanceLedgerTableInspectionSchema,
  ProvenanceReplayInsertResultSchema,
  ValidatedProvenanceJsonlReplaySchema,
  type ProvenanceJsonlReplayDisposition,
  type ProvenanceJsonlReplayInventory,
  type ProvenanceJsonlReplayIssueDisposition,
  type ProvenanceJsonlReplayIssue,
  type ProvenanceLedgerArchive,
  type ProvenanceLedgerInitInvocation,
  type ProvenanceLedgerRecoveryCliOptions,
  type ProvenanceLedgerRecoveryNextAction,
  type ProvenanceLedgerRecoveryRequest,
  type ProvenanceLedgerRecoveryResult,
  type ProvenanceLedgerRecoveryStatus,
  type ProvenanceLedgerSchemaInspection,
  type ProvenanceLedgerSchemaReasonCode,
  type ProvenanceLedgerSchemaState,
  type ProvenanceLedgerStatusCliOptions,
  type ProvenanceLedgerTableInspection,
  type ProvenanceReplayInsertResult,
  type ValidatedProvenanceJsonlReplay,
} from "../provenance-ledger-schemas.js";
import {
  deriveProvenanceJsonlReplayDisposition,
  ProvenanceJsonlReplayReader,
} from "../read-provenance-jsonl-replay.js";
import {
  ClaudeCodeProvenanceEventNameSchema,
  CodexProvenanceEventNameSchema,
  ProvenanceHookRejectionIdentitySchema,
  ProvenanceHookRejectionMarkerSchema,
  ProvenanceCaptureConfigSchema,
  ProvenanceIndexRequestSchema,
  RawProvenanceHookEventSchema,
  type ProvenanceHookRejectionIdentity,
  type ProvenanceHookRejectionMarker,
  type RawProvenanceHookEvent,
} from "../provenance-schemas.js";

const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

const LEGACY_FOUR_TABLE_DDL = `
  CREATE TABLE provenance_sessions (
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    initial_cwd TEXT NOT NULL,
    final_cwd TEXT NOT NULL,
    source TEXT,
    integrity_status TEXT NOT NULL CHECK (
      integrity_status IN ('complete', 'recoverable', 'incomplete')
    ),
    PRIMARY KEY (harness, session_id)
  );
  CREATE TABLE provenance_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    delivery_key TEXT,
    source_fingerprint TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    source_timestamp TEXT,
    harness TEXT NOT NULL,
    event_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    agent_id TEXT,
    agent_type TEXT,
    plan_name TEXT,
    task_id TEXT,
    tool_name TEXT,
    tool_use_id TEXT,
    outcome TEXT NOT NULL,
    cwd_tokenized TEXT NOT NULL,
    transcript_path_tokenized TEXT,
    sanitized_payload_json TEXT NOT NULL,
    redaction_count INTEGER NOT NULL,
    truncated_fields_json TEXT NOT NULL,
    sanitized_payload_sha256 TEXT NOT NULL,
    jsonl_state TEXT NOT NULL CHECK (jsonl_state IN ('pending', 'written')),
    embedding_state TEXT NOT NULL CHECK (
      embedding_state IN ('excluded', 'pending', 'written', 'failed')
    ),
    FOREIGN KEY (harness, session_id)
      REFERENCES provenance_sessions(harness, session_id)
  );
  CREATE UNIQUE INDEX provenance_events_delivery_key_unique
    ON provenance_events(delivery_key) WHERE delivery_key IS NOT NULL;
  CREATE INDEX provenance_events_session_sequence
    ON provenance_events(harness, session_id, sequence);
  CREATE INDEX provenance_events_jsonl_state
    ON provenance_events(jsonl_state, sequence);
  CREATE TABLE provenance_embeddings (
    event_id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    content_sha256 TEXT NOT NULL,
    embedded_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES provenance_events(event_id)
  );
  CREATE TABLE provenance_integrity_issues (
    issue_id TEXT PRIMARY KEY,
    harness TEXT,
    session_id TEXT,
    event_id TEXT,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    resolved_at TEXT
  );
  PRAGMA user_version = 0;
`;

type SchemaDerivedHookEvent = z.infer<typeof RawProvenanceHookEventSchema>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type IsOptional<Type, Key extends keyof Type> = {} extends Pick<Type, Key>
  ? true
  : false;

type ReplayIssueDispositionIsRequired = Assert<
  Equal<IsOptional<ProvenanceJsonlReplayIssue, "disposition">, false>
>;

type HookRejectionTypesAreSchemaDerived = [
  Assert<
    Equal<
      ProvenanceHookRejectionIdentity,
      z.infer<typeof ProvenanceHookRejectionIdentitySchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceHookRejectionMarker,
      z.infer<typeof ProvenanceHookRejectionMarkerSchema>
    >
  >,
];

type NullableRawHookFieldsExcludeNull = Assert<
  Equal<
    Extract<
      RawProvenanceHookEvent[
        | "transcript_path"
        | "source"
        | "model"
        | "permission_mode"
        | "prompt"
        | "tool_name"
        | "last_assistant_message"
        | "agent_id"
        | "agent_type"
        | "agent_transcript_path"
        | "turn_id"
        | "tool_use_id"
        | "trigger"
        | "custom_instructions"
        | "reason"
        | "timestamp"
      ],
      null
    >,
    never
  >
>;

const replayIssueWithoutDisposition = {
  relativePath: "codex/session.jsonl",
  lineNumber: 1,
  code: "invalid-json",
  sanitizedMessage: "Replay line is not valid JSON.",
} as const;
// @ts-expect-error Replay issues require an explicit skipped/blocking disposition.
const structurallyRejectedReplayIssue: ProvenanceJsonlReplayIssue =
  replayIssueWithoutDisposition;
void structurallyRejectedReplayIssue;

if (false) {
  deriveProvenanceLedgerRecoveryNextAction(
    "blocked",
    false,
    // @ts-expect-error Aggregate replay disposition cannot be replaced by a boolean issue flag.
    true,
    false,
    true,
  );
}

type LedgerTypesAreSchemaDerived = [
  Assert<Equal<ProvenanceLedgerSchemaState, z.infer<typeof ProvenanceLedgerSchemaStateSchema>>>,
  Assert<
    Equal<
      ProvenanceLedgerSchemaReasonCode,
      z.infer<typeof ProvenanceLedgerSchemaReasonCodeSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerTableInspection,
      z.infer<typeof ProvenanceLedgerTableInspectionSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerSchemaInspection,
      z.infer<typeof ProvenanceLedgerSchemaInspectionSchema>
    >
  >,
  Assert<Equal<ProvenanceJsonlReplayIssue, z.infer<typeof ProvenanceJsonlReplayIssueSchema>>>,
  Assert<
    Equal<
      ProvenanceJsonlReplayDisposition,
      z.infer<typeof ProvenanceJsonlReplayDispositionSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceJsonlReplayIssueDisposition,
      z.infer<typeof ProvenanceJsonlReplayIssueDispositionSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceJsonlReplayInventory,
      z.infer<typeof ProvenanceJsonlReplayInventorySchema>
    >
  >,
  Assert<
    Equal<
      ValidatedProvenanceJsonlReplay,
      z.infer<typeof ValidatedProvenanceJsonlReplaySchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerRecoveryRequest,
      z.infer<typeof ProvenanceLedgerRecoveryRequestSchema>
    >
  >,
  Assert<Equal<ProvenanceLedgerArchive, z.infer<typeof ProvenanceLedgerArchiveSchema>>>,
  Assert<
    Equal<
      ProvenanceLedgerRecoveryStatus,
      z.infer<typeof ProvenanceLedgerRecoveryStatusSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerRecoveryNextAction,
      z.infer<typeof ProvenanceLedgerRecoveryNextActionSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerRecoveryResult,
      z.infer<typeof ProvenanceLedgerRecoveryResultSchema>
    >
  >,
  Assert<Equal<ProvenanceReplayInsertResult, z.infer<typeof ProvenanceReplayInsertResultSchema>>>,
  Assert<
    Equal<
      ProvenanceLedgerStatusCliOptions,
      z.infer<typeof ProvenanceLedgerStatusCliOptionsSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerRecoveryCliOptions,
      z.infer<typeof ProvenanceLedgerRecoveryCliOptionsSchema>
    >
  >,
  Assert<
    Equal<
      ProvenanceLedgerInitInvocation,
      z.infer<typeof ProvenanceLedgerInitInvocationSchema>
    >
  >,
];

const missingLedgerInspection = {
  schemaVersion: 1,
  databasePath: "PROJECT_ROOT/.agents/data/provenance/provenance.db",
  databaseExists: false,
  recoveryMarkerPresent: false,
  expectedUserVersion: 1,
  state: "missing",
  tables: [],
  reasonCodes: ["database-missing"],
} as const;

const currentLedgerInspection = {
  schemaVersion: 1,
  databasePath: "PROJECT_ROOT/.agents/data/provenance/provenance.db",
  databaseExists: true,
  recoveryMarkerPresent: false,
  expectedUserVersion: 1,
  observedUserVersion: 1,
  state: "current",
  tables: [
    {
      tableName: "provenance_events",
      requiredColumns: ["event_id"],
      observedColumns: ["event_id"],
      missingColumns: [],
    },
    {
      tableName: "provenance_embeddings",
      requiredColumns: ["event_id"],
      observedColumns: ["event_id"],
      missingColumns: [],
    },
  ],
  reasonCodes: [],
} as const;

const unstampedLedgerInspection = {
  ...currentLedgerInspection,
  observedUserVersion: 0,
  state: "unstamped-current",
} as const;

const incompatibleLedgerInspection = {
  ...currentLedgerInspection,
  observedUserVersion: 0,
  state: "incompatible",
  tables: [],
  reasonCodes: ["required-table-missing"],
} as const;

const activeMarkerLedgerInspection = {
  ...incompatibleLedgerInspection,
  recoveryMarkerPresent: true,
  reasonCodes: ["recovery-marker-present"],
} as const;

function boundedReplayEvent(index: number, marker: string) {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${suffix}`,
    recordedAt: "2026-07-20T12:00:00.000Z",
    harness: "codex",
    eventName: "PostToolUse",
    sessionId: "bounded-replay-session",
    source: "main",
    role: "agent",
    toolName: "exec_command",
    cwd: ".",
    eventData: { marker },
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: index.toString(16).padStart(64, "a").slice(-64),
  } as const;
}

function boundedReplayLines(
  kind: "invalid" | "conflicting",
  issueCount: number,
): string[] {
  if (kind === "invalid") {
    return Array.from(
      { length: issueCount },
      (_, index) => `{not-json-RAW_RECORD_${index}`,
    );
  }

  return Array.from({ length: issueCount }, (_, index) => {
    const accepted = boundedReplayEvent(index, `RAW_RECORD_${index}`);
    const conflicting = {
      ...accepted,
      eventData: { marker: `RAW_CONFLICT_${index}` },
      contentSha256: "f".repeat(64),
    };
    return [JSON.stringify(accepted), JSON.stringify(conflicting)];
  }).flat();
}

const issueFreeReplay = {
  jsonlFileCount: 1,
  nonBlankLineCount: 0,
  validEventCount: 0,
  duplicateEventCount: 0,
  conflictingEventCount: 0,
  invalidRecordCount: 0,
  disposition: "complete",
  skippedIssueCount: 0,
  blockingIssueCount: 0,
  issueCount: 0,
  issuesShown: 0,
  issuesTruncated: false,
  issues: [],
} as const;

const recoveryNextActions = {
  none: {
    code: "none",
    message: "No recovery action is required.",
  },
  apply: {
    code: "apply-recovery",
    message: "Apply the previewed ledger recovery explicitly.",
    command: "recover-ledger --apply",
  },
  correctReplay: {
    code: "correct-replay-evidence",
    message:
      "Correct only the listed relative replay evidence locations, then rerun the recovery preview.",
    command: "recover-ledger",
  },
  wait: {
    code: "wait-inspect-retry",
    message:
      "Wait for the active recovery to finish, inspect ledger status, then retry without deleting recovery markers.",
    command: "ledger-status",
  },
  resume: {
    code: "resume-interrupted-recovery",
    message: "Resume the interrupted ledger recovery explicitly.",
    command: "recover-ledger --apply",
  },
  reviewSkipped: {
    code: "review-skipped-replay-evidence",
    message:
      "Structured recovery completed with invalid replay records excluded and preserved; review the listed relative evidence before running semantic indexing explicitly.",
  },
  index: {
    code: "run-semantic-index",
    message:
      "Structured recovery is complete; run semantic indexing explicitly.",
    command: "index",
  },
} as const;

function recoveryResult(
  mode: "dry-run" | "apply",
  status: "would-create" | "created",
) {
  return {
    schemaVersion: 1,
    mode,
    status,
    before: missingLedgerInspection,
    replay: issueFreeReplay,
    replayedEventCount: 0,
    catchUpEventCount: 0,
    semanticReindexRequired: false,
    recoveryMarkerCleared: mode === "apply",
    nextAction:
      status === "would-create"
        ? recoveryNextActions.apply
        : recoveryNextActions.none,
  };
}

test("accepts canonical Claude and Codex hook events", () => {
  for (const eventName of CLAUDE_EVENTS) {
    assert.equal(ClaudeCodeProvenanceEventNameSchema.safeParse(eventName).success, true);
  }
  for (const eventName of CODEX_EVENTS) {
    assert.equal(CodexProvenanceEventNameSchema.safeParse(eventName).success, true);
  }

  assert.deepEqual(ClaudeCodeProvenanceEventNameSchema.options, CLAUDE_EVENTS);
  assert.deepEqual(CodexProvenanceEventNameSchema.options, CODEX_EVENTS);

  const config = ProvenanceCaptureConfigSchema.parse(
    JSON.parse(
      readFileSync(new URL("../provenance.config.json", import.meta.url), "utf8"),
    ),
  );
  assert.deepEqual(config.captureEvents["claude-code"], CLAUDE_EVENTS);
  assert.deepEqual(config.captureEvents.codex, CODEX_EVENTS);
});

test("parses the manual PreCompact payload with null custom instructions", () => {
  const parsed = RawProvenanceHookEventSchema.parse({
    session_id: "0b21c348",
    transcript_path: "/Users/example/.claude/projects/project/0b21c348.jsonl",
    cwd: "/Users/example/project",
    hook_event_name: "PreCompact",
    trigger: "manual",
    custom_instructions: null,
  });

  assert.equal(parsed.hook_event_name, "PreCompact");
  assert.equal(parsed.trigger, "manual");
  assert.equal(parsed.custom_instructions, undefined);
});

test("normalizes nullable optional hook strings without admitting invalid types", () => {
  const optionalStringFields = [
    "transcript_path",
    "source",
    "model",
    "permission_mode",
    "prompt",
    "tool_name",
    "last_assistant_message",
    "agent_id",
    "agent_type",
    "agent_transcript_path",
    "turn_id",
    "tool_use_id",
    "trigger",
    "custom_instructions",
    "reason",
    "timestamp",
  ] as const;
  const requiredIdentity = {
    session_id: "nullable-session",
    cwd: "PROJECT_ROOT",
    hook_event_name: "PreCompact",
  };
  const allNull = Object.fromEntries(
    optionalStringFields.map((field) => [field, null]),
  );
  const parsed = RawProvenanceHookEventSchema.parse({
    ...requiredIdentity,
    ...allNull,
  });

  for (const field of optionalStringFields) {
    assert.equal(parsed[field], undefined, field);
  }

  for (const field of optionalStringFields.filter(
    (candidate) => candidate !== "timestamp",
  )) {
    assert.equal(
      RawProvenanceHookEventSchema.parse({
        ...requiredIdentity,
        [field]: "",
      })[field],
      "",
      `${field} preserves an empty string`,
    );
  }

  for (const field of optionalStringFields) {
    for (const invalidValue of [7, [], {}]) {
      assert.equal(
        RawProvenanceHookEventSchema.safeParse({
          ...requiredIdentity,
          [field]: invalidValue,
        }).success,
        false,
        `${field} rejects ${JSON.stringify(invalidValue)}`,
      );
    }
  }

  const nullCannotReachNormalizedTypes: NullableRawHookFieldsExcludeNull = true;
  assert.equal(nullCannotReachNormalizedTypes, true);
});

test("keeps required hook fields strict and validates rejection schemas", () => {
  for (const requiredField of ["session_id", "cwd", "hook_event_name"] as const) {
    for (const invalidValue of [undefined, null, ""]) {
      const candidate: Record<string, unknown> = {
        session_id: "schema-session",
        cwd: "PROJECT_ROOT",
        hook_event_name: "SessionStart",
        [requiredField]: invalidValue,
      };
      assert.equal(
        RawProvenanceHookEventSchema.safeParse(candidate).success,
        false,
        `${requiredField} rejects ${String(invalidValue)}`,
      );
      assert.equal(
        ProvenanceHookRejectionIdentitySchema.safeParse(candidate).success,
        false,
        `rejection identity ${requiredField} rejects ${String(invalidValue)}`,
      );
    }
  }

  assert.equal(
    ClaudeCodeProvenanceEventNameSchema.safeParse("TaskCreated").success,
    false,
  );
  assert.equal(
    CodexProvenanceEventNameSchema.safeParse("PostToolUseFailure").success,
    false,
  );
  assert.equal(
    ProvenanceHookRejectionIdentitySchema.safeParse({
      session_id: "rejected-session",
      cwd: "PROJECT_ROOT",
      hook_event_name: "TaskCreated",
    }).success,
    false,
  );

  assert.deepEqual(
    ProvenanceHookRejectionIdentitySchema.parse({
      session_id: "rejected-session",
      cwd: "PROJECT_ROOT",
      hook_event_name: "PreCompact",
      transcript_path: null,
    }),
    {
      session_id: "rejected-session",
      cwd: "PROJECT_ROOT",
      hook_event_name: "PreCompact",
      transcript_path: undefined,
    },
  );
  assert.deepEqual(
    ProvenanceHookRejectionMarkerSchema.parse({
      markerType: "hook-validation-rejection",
      captureStatus: "unrecorded",
      stage: "normalize",
      errorName: "ProvenanceAdapterValidationError",
      errorCode: "INVALID_HOOK_PAYLOAD",
      sanitizedMessage: "Claude Code hook event failed at agent_type",
      remediation: "Inspect the hook field contract.",
    }).markerType,
    "hook-validation-rejection",
  );
  assert.equal(
    ProvenanceHookRejectionMarkerSchema.safeParse({
      markerType: "hook-validation-rejection",
      captureStatus: "unrecorded",
      stage: "normalize",
      errorName: "x".repeat(129),
      sanitizedMessage: "Rejected safely.",
    }).success,
    false,
  );

  const schemaDerivedTypes: HookRejectionTypesAreSchemaDerived = [true, true];
  assert.equal(schemaDerivedTypes.every(Boolean), true);
});

test("preserves forward-compatible hook fields", () => {
  const candidate: SchemaDerivedHookEvent = {
    session_id: "forward-session",
    cwd: "PROJECT_ROOT",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    future_nested_field: { retained: [true, 7] },
  };
  const parsed = RawProvenanceHookEventSchema.parse(candidate);
  const publicBoundary: RawProvenanceHookEvent = parsed;

  assert.deepEqual(publicBoundary.future_nested_field, { retained: [true, 7] });
});

test("rejects nonpositive semantic index batch sizes", () => {
  assert.deepEqual(ProvenanceIndexRequestSchema.parse({}), {
    batchSize: 500,
    dryRun: false,
  });
  assert.equal(ProvenanceIndexRequestSchema.parse({ batchSize: 25 }).batchSize, 25);
  for (const batchSize of [0, -1, 1.5]) {
    assert.equal(
      ProvenanceIndexRequestSchema.safeParse({ batchSize }).success,
      false,
      String(batchSize),
    );
  }
});

test("accepts valid issue-free dry-run and apply recovery results", () => {
  assert.equal(
    ProvenanceLedgerRecoveryResultSchema.safeParse(
      recoveryResult("dry-run", "would-create"),
    ).success,
    true,
  );
  assert.equal(
    ProvenanceLedgerRecoveryResultSchema.safeParse(
      recoveryResult("apply", "created"),
    ).success,
    true,
  );
});

test("validates every recovery status reason and next action combination", () => {
  const replayIssue = {
    relativePath: "codex/session.jsonl",
    lineNumber: 7,
    disposition: "blocking",
    code: "conflicting-event-id",
    sanitizedMessage: "Replay event ID conflicts with accepted evidence.",
  } as const;
  const replayWithIssue = {
    ...issueFreeReplay,
    nonBlankLineCount: 1,
    conflictingEventCount: 1,
    disposition: "blocked",
    blockingIssueCount: 1,
    issueCount: 1,
    issuesShown: 1,
    issues: [replayIssue],
  } as const;
  const archive = {
    directory: "provenance.db.archive-token",
    databaseFile: "provenance.db.archive-token/provenance.db",
  } as const;
  const cases = [
    {
      name: "ready current",
      mode: "dry-run",
      status: "current",
      before: currentLedgerInspection,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.none,
    },
    {
      name: "would create",
      mode: "dry-run",
      status: "would-create",
      before: missingLedgerInspection,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.apply,
    },
    {
      name: "would stamp",
      mode: "dry-run",
      status: "would-stamp",
      before: unstampedLedgerInspection,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.apply,
    },
    {
      name: "would rebuild with replay",
      mode: "dry-run",
      status: "would-rebuild",
      before: incompatibleLedgerInspection,
      semanticReindexRequired: true,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.apply,
    },
    {
      name: "blocked replay evidence",
      mode: "dry-run",
      status: "blocked",
      before: incompatibleLedgerInspection,
      replay: replayWithIssue,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.correctReplay,
    },
    {
      name: "blocked active marker",
      mode: "dry-run",
      status: "blocked",
      before: activeMarkerLedgerInspection,
      semanticReindexRequired: false,
      recoveryMarkerCleared: false,
      nextAction: recoveryNextActions.wait,
    },
    {
      name: "blocked interrupted recovery",
      mode: "dry-run",
      status: "blocked",
      before: incompatibleLedgerInspection,
      semanticReindexRequired: false,
      recoveryMarkerCleared: true,
      nextAction: recoveryNextActions.resume,
    },
    ...(["created", "stamped", "rebuilt"] as const).flatMap((status) =>
      [false, true].map((semanticReindexRequired) => ({
        name: `${status} with semantic reindex ${String(semanticReindexRequired)}`,
        mode: "apply" as const,
        status,
        before:
          status === "created"
            ? missingLedgerInspection
            : status === "stamped"
              ? unstampedLedgerInspection
              : incompatibleLedgerInspection,
        after: currentLedgerInspection,
        ...(status === "rebuilt" ? { archive } : {}),
        semanticReindexRequired,
        recoveryMarkerCleared: true,
        nextAction: semanticReindexRequired
          ? recoveryNextActions.index
          : recoveryNextActions.none,
      })),
    ),
  ] as const;

  for (const recoveryCase of cases) {
    const candidate = {
      schemaVersion: 1,
      replay: issueFreeReplay,
      replayedEventCount: 0,
      catchUpEventCount: 0,
      ...recoveryCase,
    };
    assert.equal(
      ProvenanceLedgerRecoveryResultSchema.safeParse(candidate).success,
      true,
      recoveryCase.name,
    );
    const wrongNextAction =
      recoveryCase.nextAction.code === "none"
        ? recoveryNextActions.apply
        : recoveryNextActions.none;
    assert.equal(
      ProvenanceLedgerRecoveryResultSchema.safeParse({
        ...candidate,
        nextAction: wrongNextAction,
      }).success,
      false,
      `${recoveryCase.name} rejects a contradictory action`,
    );
  }
});

test("keeps recovery next actions closed bounded and free of unsafe detail", () => {
  for (const nextAction of Object.values(recoveryNextActions)) {
    const parsed = ProvenanceLedgerRecoveryNextActionSchema.parse(nextAction);
    assert.ok(parsed.message.length <= 192);
    assert.doesNotMatch(
      JSON.stringify(parsed),
      /(?:[A-Za-z]:\\|\/Users\/|payload|credential|password|token=|raw input)/i,
    );
  }
  assert.equal(
    ProvenanceLedgerRecoveryNextActionSchema.safeParse({
      ...recoveryNextActions.index,
      command: "index --database C:\\Users\\person\\provenance.db",
    }).success,
    false,
  );
  assert.equal(
    ProvenanceLedgerRecoveryNextActionSchema.safeParse({
      ...recoveryNextActions.none,
      details: { rawInput: "secret" },
    }).success,
    false,
  );
  assert.equal(
    ProvenanceLedgerRecoveryNextActionSchema.safeParse({
      ...recoveryNextActions.reviewSkipped,
      command: "index",
    }).success,
    false,
  );
});

test("derives recovery next actions from aggregate replay disposition", () => {
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "would-rebuild",
      true,
      "partial",
      false,
      true,
    ),
    recoveryNextActions.apply,
  );
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "blocked",
      false,
      "blocked",
      true,
      false,
    ),
    recoveryNextActions.correctReplay,
  );
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "blocked",
      false,
      "partial",
      true,
      false,
    ),
    recoveryNextActions.wait,
  );
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "blocked",
      false,
      "partial",
      false,
      true,
    ),
    recoveryNextActions.resume,
  );
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "rebuilt",
      true,
      "partial",
      false,
      true,
    ),
    recoveryNextActions.reviewSkipped,
  );
  assert.deepEqual(
    deriveProvenanceLedgerRecoveryNextAction(
      "rebuilt",
      true,
      "complete",
      false,
      true,
    ),
    recoveryNextActions.index,
  );
});

test("permits skipped replay issues and blocks conflicting replay issues", () => {
  const replayIssues = [
    {
      code: "invalid-json",
      issueDisposition: "skipped",
      disposition: "partial",
      invalidRecordCount: 1,
      conflictingEventCount: 0,
      accepted: true,
    },
    {
      code: "invalid-redacted-event",
      issueDisposition: "skipped",
      disposition: "partial",
      invalidRecordCount: 1,
      conflictingEventCount: 0,
      accepted: true,
    },
    {
      code: "conflicting-event-id",
      issueDisposition: "blocking",
      disposition: "blocked",
      invalidRecordCount: 0,
      conflictingEventCount: 1,
      accepted: false,
    },
  ] as const;

  for (const replayIssue of replayIssues) {
    const candidate = recoveryResult("apply", "created");
    assert.equal(
      ProvenanceLedgerRecoveryResultSchema.safeParse({
        ...candidate,
        nextAction: replayIssue.accepted
          ? recoveryNextActions.reviewSkipped
          : recoveryNextActions.none,
        replay: {
          ...candidate.replay,
          invalidRecordCount: replayIssue.invalidRecordCount,
          conflictingEventCount: replayIssue.conflictingEventCount,
          disposition: replayIssue.disposition,
          skippedIssueCount: replayIssue.invalidRecordCount,
          blockingIssueCount: replayIssue.conflictingEventCount,
          issueCount: 1,
          issuesShown: 1,
          issues: [
            {
              relativePath: "session/events.jsonl",
              lineNumber: 1,
              disposition: replayIssue.issueDisposition,
              code: replayIssue.code,
              sanitizedMessage: "Replay input is not safe to apply.",
            },
          ],
        },
      }).success,
      replayIssue.accepted,
      replayIssue.code,
    );
  }
});

test("rejects replay issue classifications with contradictory zero counters", () => {
  for (const code of [
    "invalid-json",
    "invalid-redacted-event",
    "conflicting-event-id",
  ] as const) {
    const candidate = recoveryResult("apply", "created");
    assert.equal(
      ProvenanceLedgerRecoveryResultSchema.safeParse({
        ...candidate,
        replay: {
          ...candidate.replay,
          issueCount: 1,
          issuesShown: 1,
          issues: [
            {
              relativePath: "session/events.jsonl",
              lineNumber: 1,
              disposition:
                code === "conflicting-event-id" ? "blocking" : "skipped",
              code,
              sanitizedMessage: "Replay inventory counters are inconsistent.",
            },
          ],
        },
      }).success,
      false,
      code,
    );
  }
});

test("classifies the four provenance ledger schema states", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "provenance-schema-states-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const inspector = new ProvenanceLedgerSchemaInspector();
  const missingDatabasePath = join(fixtureRoot, "missing", "provenance.db");
  const missingParentPath = dirname(missingDatabasePath);
  assert.equal(existsSync(missingParentPath), false);
  const missingInspection = inspector.inspect(missingDatabasePath);
  assert.equal(missingInspection.state, "missing");
  assert.equal(missingInspection.observedUserVersion, undefined);
  assert.deepEqual(missingInspection.reasonCodes, ["database-missing"]);
  assert.deepEqual(missingInspection.tables, []);
  assert.equal(existsSync(missingParentPath), false);
  assert.equal(existsSync(missingDatabasePath), false);

  const currentDatabasePath = join(fixtureRoot, "current.db");
  const currentDatabase = new Database(currentDatabasePath);
  createCurrentProvenanceLedgerSchema(currentDatabase);
  currentDatabase.close();
  const currentInspection = inspector.inspect(currentDatabasePath);
  assert.equal(currentInspection.state, "current");
  assert.equal(
    currentInspection.observedUserVersion,
    PROVENANCE_LEDGER_USER_VERSION,
  );
  assert.deepEqual(currentInspection.reasonCodes, []);

  const unstampedDatabasePath = join(fixtureRoot, "unstamped-current.db");
  const unstampedDatabase = new Database(unstampedDatabasePath);
  createCurrentProvenanceLedgerSchema(unstampedDatabase);
  unstampedDatabase.pragma("user_version = 0");
  unstampedDatabase.close();
  const unstampedInspection = inspector.inspect(unstampedDatabasePath);
  assert.equal(unstampedInspection.state, "unstamped-current");
  assert.equal(unstampedInspection.observedUserVersion, 0);
  assert.deepEqual(unstampedInspection.reasonCodes, []);

  for (const inspection of [currentInspection, unstampedInspection]) {
    assert.deepEqual(
      inspection.tables.map((table) => ({
        tableName: table.tableName,
        requiredColumns: table.requiredColumns,
        observedColumns: table.observedColumns,
        missingColumns: table.missingColumns,
      })),
      Object.entries(PROVENANCE_LEDGER_REQUIRED_COLUMNS).map(
        ([tableName, requiredColumns]) => ({
          tableName,
          requiredColumns,
          observedColumns: requiredColumns,
          missingColumns: [],
        }),
      ),
    );
  }

  const legacyDatabasePath = join(fixtureRoot, "legacy.db");
  const legacyDatabase = new Database(legacyDatabasePath);
  legacyDatabase.exec(LEGACY_FOUR_TABLE_DDL);
  legacyDatabase.close();
  const incompatibleInspection = inspector.inspect(legacyDatabasePath);
  assert.equal(incompatibleInspection.state, "incompatible");
  assert.equal(incompatibleInspection.observedUserVersion, 0);
  assert.deepEqual(incompatibleInspection.reasonCodes, [
    "required-column-missing",
  ]);
  assert.deepEqual(
    incompatibleInspection.tables.map((table) => table.tableName),
    ["provenance_events", "provenance_embeddings"],
  );
  assert.ok(
    incompatibleInspection.tables.every(
      (table) => table.missingColumns.length > 0,
    ),
  );
});

test("validates replay inventory counts and safe issue shapes", () => {
  const issue = {
    relativePath: "codex/session.jsonl",
    lineNumber: 7,
    disposition: "skipped",
    code: "invalid-json",
    sanitizedMessage: "Replay line is not valid JSON.",
  } as const;
  assert.deepEqual(ProvenanceJsonlReplayIssueSchema.parse(issue), issue);
  assert.equal(
    ProvenanceJsonlReplayIssueSchema.safeParse({
      ...issue,
      lineNumber: 0,
    }).success,
    false,
  );
  assert.equal(
    ProvenanceJsonlReplayIssueSchema.safeParse({
      ...issue,
      sanitizedMessage: "x".repeat(513),
    }).success,
    false,
  );
  assert.equal(
    ProvenanceJsonlReplayIssueSchema.safeParse({
      ...issue,
      disposition: undefined,
    }).success,
    false,
  );
  assert.equal(
    ProvenanceJsonlReplayIssueSchema.safeParse({
      ...issue,
      disposition: "blocking",
    }).success,
    false,
  );

  const inventory = {
    jsonlFileCount: 1,
    nonBlankLineCount: 2,
    validEventCount: 1,
    duplicateEventCount: 0,
    conflictingEventCount: 0,
    invalidRecordCount: 1,
    disposition: "partial",
    skippedIssueCount: 1,
    blockingIssueCount: 0,
    issueCount: 1,
    issuesShown: 1,
    issuesTruncated: false,
    issues: [issue],
  } as const;
  assert.deepEqual(ProvenanceJsonlReplayInventorySchema.parse(inventory), inventory);
  assert.equal(
    ProvenanceJsonlReplayInventorySchema.safeParse({
      ...inventory,
      invalidRecordCount: 0,
    }).success,
    false,
  );

  for (const contradictory of [
    { ...inventory, issueCount: 2 },
    { ...inventory, issuesShown: 0 },
    { ...inventory, issuesTruncated: true },
  ]) {
    assert.deepEqual(
      ProvenanceJsonlReplayInventorySchema.parse(contradictory),
      inventory,
    );
  }
});

test("derives complete partial and blocked replay aggregate fields", () => {
  const cases = [
    {
      invalidRecordCount: 0,
      conflictingEventCount: 0,
      disposition: "complete",
    },
    {
      invalidRecordCount: 4,
      conflictingEventCount: 0,
      disposition: "partial",
    },
    {
      invalidRecordCount: 4,
      conflictingEventCount: 1,
      disposition: "blocked",
    },
  ] as const;

  for (const replayCase of cases) {
    const parsed = ProvenanceJsonlReplayInventorySchema.parse({
      ...issueFreeReplay,
      invalidRecordCount: replayCase.invalidRecordCount,
      conflictingEventCount: replayCase.conflictingEventCount,
    });
    assert.equal(
      deriveProvenanceJsonlReplayDisposition(
        replayCase.invalidRecordCount,
        replayCase.conflictingEventCount,
      ),
      replayCase.disposition,
    );
    assert.equal(parsed.disposition, replayCase.disposition);
    assert.equal(parsed.skippedIssueCount, replayCase.invalidRecordCount);
    assert.equal(parsed.blockingIssueCount, replayCase.conflictingEventCount);
  }
});

test("permits rebuilt partial evidence and rejects rebuilt blocked evidence", () => {
  const archive = {
    directory: "provenance.db.archive-token",
    databaseFile: "provenance.db.archive-token/provenance.db",
  } as const;
  const rebuilt = {
    schemaVersion: 1,
    mode: "apply",
    status: "rebuilt",
    before: incompatibleLedgerInspection,
    after: currentLedgerInspection,
    replayedEventCount: 1,
    catchUpEventCount: 0,
    archive,
    semanticReindexRequired: true,
    recoveryMarkerCleared: true,
  } as const;
  const partialReplay = ProvenanceJsonlReplayInventorySchema.parse({
    ...issueFreeReplay,
    nonBlankLineCount: 2,
    validEventCount: 1,
    invalidRecordCount: 1,
    issues: [
      {
        relativePath: "session/events.jsonl",
        lineNumber: 2,
        disposition: "skipped",
        code: "invalid-redacted-event",
        sanitizedMessage: "Replay record was skipped.",
      },
    ],
  });
  assert.equal(
    ProvenanceLedgerRecoveryResultSchema.safeParse({
      ...rebuilt,
      replay: partialReplay,
      nextAction: recoveryNextActions.reviewSkipped,
    }).success,
    true,
  );

  const blockedReplay = ProvenanceJsonlReplayInventorySchema.parse({
    ...issueFreeReplay,
    nonBlankLineCount: 1,
    conflictingEventCount: 1,
  });
  assert.equal(blockedReplay.issues.length, 0);
  assert.equal(blockedReplay.disposition, "blocked");
  assert.equal(
    ProvenanceLedgerRecoveryResultSchema.safeParse({
      ...rebuilt,
      replay: blockedReplay,
      nextAction: recoveryNextActions.index,
    }).success,
    false,
  );
});

test("bounds invalid and conflicting replay diagnostics at stable CLI limit", async (t) => {
  const counts = [
    PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT - 1,
    PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT,
    PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT + 3,
  ] as const;

  for (const kind of ["invalid", "conflicting"] as const) {
    const serializedAtLimit: string[] = [];
    for (const issueCount of counts) {
      await t.test(`${kind} ${issueCount}`, async (t) => {
        const fixtureRoot = await mkdtemp(
          join(tmpdir(), `provenance-replay-bound-${kind}-`),
        );
        t.after(async () => {
          await rm(fixtureRoot, { recursive: true, force: true });
        });
        await writeFile(
          join(fixtureRoot, "events.jsonl"),
          `${boundedReplayLines(kind, issueCount).join("\n")}\n`,
          "utf8",
        );

        const replay = await new ProvenanceJsonlReplayReader().read(fixtureRoot);
        const expectedShown = Math.min(
          issueCount,
          PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT,
        );
        assert.equal(replay.issueCount, issueCount);
        assert.equal(replay.issuesShown, expectedShown);
        assert.equal(replay.issues.length, expectedShown);
        assert.equal(
          replay.issuesTruncated,
          issueCount > PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT,
        );
        assert.equal(
          replay.invalidRecordCount,
          kind === "invalid" ? issueCount : 0,
        );
        assert.equal(
          replay.conflictingEventCount,
          kind === "conflicting" ? issueCount : 0,
        );
        assert.equal(replay.disposition, kind === "invalid" ? "partial" : "blocked");
        assert.equal(replay.skippedIssueCount, kind === "invalid" ? issueCount : 0);
        assert.equal(
          replay.blockingIssueCount,
          kind === "conflicting" ? issueCount : 0,
        );
        assert.ok(
          replay.issues.every(
            (issue) =>
              issue.disposition ===
              (kind === "invalid" ? "skipped" : "blocking"),
          ),
        );
        assert.deepEqual(
          replay.issues.map((issue) => issue.lineNumber),
          Array.from(
            { length: expectedShown },
            (_, index) => (kind === "invalid" ? index + 1 : (index + 1) * 2),
          ),
        );

        const serializedIssues = JSON.stringify(replay.issues);
        assert.doesNotMatch(serializedIssues, /RAW_(?:RECORD|CONFLICT)/u);
        if (issueCount === PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT) {
          serializedAtLimit.push(serializedIssues);
        }
        if (issueCount > PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT) {
          assert.equal(serializedIssues, serializedAtLimit[0]);
        }
      });
    }
  }
});

test("blocks a conflict beyond the retained diagnostic prefix", async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "provenance-replay-conflict-after-limit-"),
  );
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const accepted = boundedReplayEvent(500, "accepted");
  const conflicting = {
    ...accepted,
    eventData: { marker: "conflicting" },
    contentSha256: "f".repeat(64),
  };
  await writeFile(
    join(fixtureRoot, "events.jsonl"),
    `${[
      ...boundedReplayLines("invalid", PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT),
      JSON.stringify(accepted),
      JSON.stringify(conflicting),
    ].join("\n")}\n`,
    "utf8",
  );

  const replay = await new ProvenanceJsonlReplayReader().read(fixtureRoot);
  assert.equal(replay.issues.length, PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT);
  assert.ok(
    replay.issues
      .slice(0, -1)
      .every((issue) => issue.disposition === "skipped"),
  );
  assert.deepEqual(replay.issues.at(-1), {
    relativePath: "events.jsonl",
    lineNumber: PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT + 2,
    disposition: "blocking",
    code: "conflicting-event-id",
    sanitizedMessage:
      "The event ID is reused by a different redacted provenance event.",
  });
  assert.equal(replay.invalidRecordCount, PROVENANCE_JSONL_REPLAY_ISSUE_LIMIT);
  assert.equal(replay.conflictingEventCount, 1);
  assert.equal(replay.blockingIssueCount, 1);
  assert.equal(replay.disposition, "blocked");
  assert.equal(replay.issuesTruncated, true);
  assert.doesNotMatch(JSON.stringify(replay.issues), /RAW_(?:RECORD|CONFLICT)/u);
});

test("defaults recovery requests to dry-run", () => {
  assert.deepEqual(ProvenanceLedgerRecoveryRequestSchema.parse({}), {
    mode: "dry-run",
  });
  assert.deepEqual(ProvenanceLedgerRecoveryRequestSchema.parse({ mode: "apply" }), {
    mode: "apply",
  });
});

test("derives every new public type from its Zod schema", () => {
  const dispositionIsRequired: ReplayIssueDispositionIsRequired = true;
  const compileTimeAssertions: LedgerTypesAreSchemaDerived = Array.from(
    { length: 18 },
    () => true as const,
  ) as LedgerTypesAreSchemaDerived;
  assert.equal(dispositionIsRequired, true);
  assert.equal(compileTimeAssertions.every(Boolean), true);
});
