import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Command as Commander, CommanderError } from "commander";

import {
  LocalProvenanceEmbeddingProvider,
  ProvenanceEventIndexer,
} from "./embed-provenance-events.js";
import {
  ProvenanceLedgerSchemaDriftError,
} from "./provenance-ledger-definition.js";
import {
  ProvenanceLedgerRecoveryCliOptionsSchema,
  ProvenanceLedgerRecoveryRequestSchema,
  ProvenanceLedgerStatusCliOptionsSchema,
} from "./provenance-ledger-schemas.js";
import {
  HarnessIdSchema,
  ProvenanceCaptureConfigSchema,
  ProvenanceEventNameSchema,
  ProvenanceIndexRequestSchema,
  ProvenancePatternQuerySchema,
  ProvenanceQueryFilterSchema,
  ProvenanceSemanticQuerySchema,
  type ProvenanceCaptureConfig,
  type ProvenanceQueryFilter,
} from "./provenance-schemas.js";
import { ProvenanceEventQueryService } from "./query-provenance-ledger.js";
import {
  ProvenanceLedgerRecoveryBlockedError,
  ProvenanceLedgerRecoveryOperationError,
  ProvenanceLedgerRecoveryService,
  type ProvenanceLedgerRecoveryOperationStage,
} from "./recover-provenance-ledger.js";
import {
  projectProvenanceStructuredOutput,
  sanitizeProvenanceDiagnosticMessage,
} from "./sanitize-provenance-diagnostic.js";

type StructuredFilterOptions = {
  harness?: string;
  sessionId?: string;
  workflow?: string;
  agent?: string;
  eventName?: string;
  toolName?: string;
  from?: string;
  to?: string;
  limit: number;
};

type ProvenanceCliPaths = {
  databasePath: string;
  modelCacheDirectory: string;
};

type CliDiagnosticContext = {
  commandName: string;
  identifiers: Record<string, string>;
};

type CliErrorCause =
  | "active-recovery-marker"
  | "interrupted-recovery"
  | "post-swap-replay"
  | "pre-mutation-replay"
  | "schema-drift"
  | ProvenanceLedgerRecoveryOperationStage;

type CliNextAction = {
  code: string;
  command?: string;
  message: string;
};

type CliErrorEnvelope = {
  schemaVersion: 1;
  error: {
    code:
      | "PROVENANCE_LEDGER_RECOVERY_BLOCKED"
      | "PROVENANCE_LEDGER_RECOVERY_OPERATION_FAILED"
      | "PROVENANCE_LEDGER_RECOVERY_CLEANUP_FAILED"
      | "PROVENANCE_LEDGER_SCHEMA_DRIFT";
    cause: CliErrorCause;
    message: string;
    details: unknown;
    nextAction: CliNextAction;
  };
};

const CLI_COMMAND_NAMES = new Set([
  "failures",
  "agent-summary",
  "search",
  "similar",
  "patterns",
  "sessions",
  "events",
  "export",
  "index",
  "ledger-status",
  "recover-ledger",
]);

const CLI_OPTIONS_WITH_VALUES = new Set([
  "--harness",
  "--session-id",
  "--workflow",
  "--agent",
  "--event-name",
  "--tool-name",
  "--from",
  "--to",
  "--type",
  "--event-id",
  "--threshold",
  "--batch-size",
  "--limit",
  "--format",
]);

const CLI_BOOLEAN_OPTIONS = new Set([
  "--by-agent",
  "--across-workflows",
  "--dry-run",
  "--require-ready",
  "--apply",
  "--help",
  "--version",
]);

export async function runProvenanceCli(
  argv: string[],
  stdin: NodeJS.ReadableStream,
  recoveryServiceFactory: ProvenanceLedgerRecoveryServiceFactory =
    createProvenanceLedgerRecoveryService,
): Promise<number> {
  void stdin;
  let repositoryRoot = process.env.PROVENANCE_PROJECT_ROOT ?? process.cwd();
  let queryService: ProvenanceEventQueryService | undefined;
  const diagnosticContext = createCliDiagnosticContext(argv);
  try {
    repositoryRoot = resolveRepositoryRoot(repositoryRoot);
    const config = loadConfig(repositoryRoot);
    const paths: ProvenanceCliPaths = {
      databasePath: resolveConfiguredPath(repositoryRoot, config.paths.ledger),
      modelCacheDirectory: resolveConfiguredPath(
        repositoryRoot,
        config.paths.modelCacheDirectory,
      ),
    };
    const provider = new LocalProvenanceEmbeddingProvider(
      paths.modelCacheDirectory,
      config.embeddings.modelId,
    );
    const getQueryService = (): ProvenanceEventQueryService => {
      queryService ??= new ProvenanceEventQueryService({
        databasePath: paths.databasePath,
        embeddingProvider: provider,
      });
      return queryService;
    };
    const recoveryService = recoveryServiceFactory(
      repositoryRoot,
      config,
    );
    const program = createProgram(
      getQueryService,
      () =>
        new ProvenanceEventIndexer({
          databasePath: paths.databasePath,
          embeddingProvider: provider,
        }),
      () => recoveryService,
      repositoryRoot,
    );
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        writeCliError(error, repositoryRoot, diagnosticContext);
      }
      return error.exitCode;
    }
    writeCliError(error, repositoryRoot, diagnosticContext);
    return 1;
  } finally {
    queryService?.close();
  }
}

export function createCliDiagnosticContext(
  argv: string[],
): CliDiagnosticContext {
  const candidateCommand = argv[0];
  const commandName =
    candidateCommand !== undefined && CLI_COMMAND_NAMES.has(candidateCommand)
      ? candidateCommand
      : "unknown";
  const identifiers: Record<string, string> = {};

  collectOptionIdentifier(argv, "--harness", "harness", identifiers);
  collectOptionIdentifier(argv, "--session-id", "sessionId", identifiers);
  collectOptionIdentifier(argv, "--event-name", "eventName", identifiers);
  collectOptionIdentifier(argv, "--workflow", "workflowId", identifiers);
  collectOptionIdentifier(argv, "--agent", "agent", identifiers);

  const positionalIdentifier = findPositionalIdentifier(argv);
  if (
    positionalIdentifier !== undefined &&
    (commandName === "agent-summary" ||
      commandName === "export" ||
      commandName === "similar")
  ) {
    const identifierName =
      commandName === "similar" ? "eventId" : "sessionId";
    identifiers[identifierName] = diagnosticIdentifierValue(
      identifierName,
      positionalIdentifier,
    );
  }

  return { commandName, identifiers };
}

function createProgram(
  getQueryService: () => ProvenanceEventQueryService,
  createIndexer: () => ProvenanceEventIndexer,
  getRecoveryService: () => ProvenanceLedgerRecoveryService,
  repositoryRoot: string,
): Commander {
  const program = new Commander()
    .name("provenance")
    .description("Inspect and explicitly index the local provenance activity trail")
    .configureOutput({
      // Commander otherwise writes the raw option text before exitOverride
      // reaches our single sanitized diagnostic boundary.
      writeErr: () => undefined,
    })
    .exitOverride();

  addStructuredFilterOptions(
    program.command("failures").description("List tool failures"),
  )
    .option("--by-agent", "group failures by actor", false)
    .action((options: StructuredFilterOptions & { byAgent: boolean }) => {
      writeJson(
        getQueryService().listFailures(
          structuredFilter(options),
          options.byAgent,
        ),
      );
    });

  addStructuredFilterOptions(
    program.command("agent-summary").description("Summarize agent activity"),
  )
    .argument("[session-id]")
    .action((sessionId: string | undefined, options: StructuredFilterOptions) => {
      writeJson(
        getQueryService().summarizeAgents(
          structuredFilter({
            ...options,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        ),
      );
    });

  program
    .command("search")
    .description("Semantically search already indexed redacted events")
    .argument("<text>")
    .option("--type <eventName>", "legacy event-name filter")
    .option("--event-name <eventName>")
    .option("--limit <count>", "maximum hits", parseInteger, 10)
    .action(
      async (
        text: string,
        options: { type?: string; eventName?: string; limit: number },
      ) => {
        writeJson(
          await getQueryService().search(
            ProvenanceSemanticQuerySchema.parse({
              text,
              eventName: options.eventName ?? options.type,
              limit: options.limit,
            }),
          ),
        );
      },
    );

  program
    .command("similar")
    .description("Find indexed events similar to a stored event")
    .argument("[event-id]")
    .option("--event-id <eventId>", "legacy source-event option")
    .option("--across-workflows", "include workflows other than the source", false)
    .option("--limit <count>", "maximum hits", parseInteger, 10)
    .action(
      async (
        positionalEventId: string | undefined,
        options: {
          eventId?: string;
          acrossWorkflows: boolean;
          limit: number;
        },
      ) => {
        const eventId = positionalEventId ?? options.eventId;
        if (eventId === undefined) {
          throw new Error("similar requires an event ID");
        }
        writeJson(
          await getQueryService().findSimilar(
            eventId,
            options.acrossWorkflows,
            options.limit,
          ),
        );
      },
    );

  program
    .command("patterns")
    .description("Find recurring failures in different workflows")
    .option("--workflow <workflowId>")
    .option("--threshold <score>", "minimum cosine score", parseNumber, 0.5)
    .option("--limit <count>", "maximum pairs", parseInteger, 10)
    .action(
      async (options: {
        workflow?: string;
        threshold: number;
        limit: number;
      }) => {
        writeJson(
          await getQueryService().findPatterns(
            ProvenancePatternQuerySchema.parse({
              workflowId: options.workflow,
              threshold: options.threshold,
              limit: options.limit,
            }),
          ),
        );
      },
    );

  addStructuredFilterOptions(
    program.command("sessions").description("List provenance sessions"),
  ).action((options: StructuredFilterOptions) => {
    writeJson(getQueryService().listSessions(structuredFilter(options)));
  });

  addStructuredFilterOptions(
    program.command("events").description("List provenance events"),
  ).action((options: StructuredFilterOptions) => {
    writeJson(getQueryService().listEvents(structuredFilter(options)));
  });

  addStructuredFilterOptions(
    program.command("export").description("Export filtered events"),
    10_000,
  )
    .argument("[session-id]")
    .option("--format <format>", "json or jsonl", "json")
    .action(
      (
        sessionId: string | undefined,
        options: StructuredFilterOptions & { format: string },
      ) => {
        if (options.format !== "json" && options.format !== "jsonl") {
          throw new Error("Export format must be json or jsonl");
        }
        const output = getQueryService().exportEvents(
          structuredFilter({
            ...options,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
          options.format,
        );
        process.stdout.write(output);
        if (options.format === "json") process.stdout.write("\n");
      },
    );

  program
    .command("index")
    .description("Explicitly index unindexed redacted events")
    .option("--batch-size <count>", "positive batch size", parseInteger, 500)
    .option("--dry-run", "report eligible events without mutation", false)
    .action(async (options: { batchSize: number; dryRun: boolean }) => {
      writeJson(
        await createIndexer().index(
          ProvenanceIndexRequestSchema.parse({
            batchSize: options.batchSize,
            dryRun: options.dryRun,
          }),
        ),
      );
    });

  program
    .command("ledger-status")
    .description("Inspect provenance ledger schema readiness without mutation")
    .option(
      "--require-ready",
      "fail unless the ledger is missing or current",
      false,
    )
    .action((options: { requireReady: boolean }) => {
      const parsed = ProvenanceLedgerStatusCliOptionsSchema.parse(options);
      const inspection = getRecoveryService().inspect();
      if (
        parsed.requireReady &&
        (inspection.recoveryMarkerPresent ||
          inspection.state === "unstamped-current" ||
          inspection.state === "incompatible")
      ) {
        throw new ProvenanceLedgerSchemaDriftError(inspection);
      }
      writeJson(inspection, repositoryRoot);
    });

  program
    .command("recover-ledger")
    .description("Preview or explicitly apply JSONL-backed ledger recovery")
    .option("--apply", "archive and recover the configured ledger", false)
    .action(async (options: { apply: boolean }) => {
      const parsed = ProvenanceLedgerRecoveryCliOptionsSchema.parse(options);
      const request = ProvenanceLedgerRecoveryRequestSchema.parse({
        mode: parsed.apply ? "apply" : "dry-run",
      });
      writeJson(
        await getRecoveryService().recoverForCli(request),
        repositoryRoot,
      );
    });

  return program;
}

export function createProvenanceLedgerRecoveryService(
  repositoryRoot: string,
  config: ProvenanceCaptureConfig,
): ProvenanceLedgerRecoveryService {
  return new ProvenanceLedgerRecoveryService(
    resolveConfiguredPath(repositoryRoot, config.paths.ledger),
    resolveConfiguredPath(repositoryRoot, config.paths.jsonlDirectory),
  );
}

export type ProvenanceLedgerRecoveryServiceFactory = (
  repositoryRoot: string,
  config: ProvenanceCaptureConfig,
) => ProvenanceLedgerRecoveryService;

function addStructuredFilterOptions(
  command: Commander,
  defaultLimit = 100,
): Commander {
  return command
    .option("--harness <harness>")
    .option("--session-id <sessionId>")
    .option("--workflow <workflowId>")
    .option("--agent <agent>")
    .option("--event-name <eventName>")
    .option("--tool-name <toolName>")
    .option("--from <datetime>")
    .option("--to <datetime>")
    .option("--limit <count>", "maximum records", parseInteger, defaultLimit);
}

function structuredFilter(options: StructuredFilterOptions): ProvenanceQueryFilter {
  return ProvenanceQueryFilterSchema.parse({
    harness: options.harness,
    sessionId: options.sessionId,
    workflowId: options.workflow,
    agent: options.agent,
    eventName: options.eventName,
    toolName: options.toolName,
    from: options.from,
    to: options.to,
    limit: options.limit,
  });
}

function loadConfig(repositoryRoot: string): ProvenanceCaptureConfig {
  const configPath = resolve(
    repositoryRoot,
    ".agents",
    "provenance",
    "provenance.config.json",
  );
  return ProvenanceCaptureConfigSchema.parse(
    JSON.parse(readFileSync(configPath, "utf8")) as unknown,
  );
}

function resolveRepositoryRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  while (true) {
    if (
      existsSync(
        resolve(current, ".agents", "provenance", "provenance.config.json"),
      )
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the project provenance configuration");
    }
    current = parent;
  }
}

function resolveConfiguredPath(
  repositoryRoot: string,
  configuredPath: string,
): string {
  if (isAbsolute(configuredPath)) {
    throw new Error("Provenance data paths must be project-relative");
  }
  const resolvedPath = resolve(repositoryRoot, configuredPath);
  const projectRelativePath = relative(repositoryRoot, resolvedPath);
  if (
    projectRelativePath === ".." ||
    projectRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(projectRelativePath)
  ) {
    throw new Error("Provenance data path escapes the project root");
  }
  return resolvedPath;
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("Expected an integer option");
  return parsed;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Expected a numeric option");
  return parsed;
}

function collectOptionIdentifier(
  argv: string[],
  optionName: string,
  identifierName: string,
  identifiers: Record<string, string>,
): void {
  const value = findOptionValue(argv, optionName);
  if (value !== undefined && !isRecognizedCliOption(value)) {
    identifiers[identifierName] = diagnosticIdentifierValue(
      identifierName,
      value,
    );
  }
}

function findOptionValue(argv: string[], optionName: string): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === optionName) return argv[index + 1];
    if (argument?.startsWith(`${optionName}=`)) {
      return argument.slice(optionName.length + 1);
    }
  }
  return undefined;
}

function findPositionalIdentifier(argv: string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") return argv[index + 1];
    if (!argument.startsWith("--")) return argument;
    const optionName = argument.split("=", 1)[0];
    if (
      optionName !== undefined &&
      CLI_OPTIONS_WITH_VALUES.has(optionName) &&
      !argument.includes("=")
    ) {
      index += 1;
    }
  }
  return undefined;
}

function isRecognizedCliOption(value: string): boolean {
  const optionName = value.split("=", 1)[0];
  return (
    optionName !== undefined &&
    (CLI_OPTIONS_WITH_VALUES.has(optionName) || CLI_BOOLEAN_OPTIONS.has(optionName))
  );
}

function diagnosticIdentifierValue(identifierName: string, value: string): string {
  if (identifierName === "harness") {
    const harness = HarnessIdSchema.safeParse(value);
    if (harness.success) return harness.data;
  }
  if (identifierName === "eventName") {
    const eventName = ProvenanceEventNameSchema.safeParse(value);
    if (eventName.success) return eventName.data;
  }
  return diagnosticCorrelationToken(value);
}

function diagnosticCorrelationToken(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

function writeCliError(
  error: unknown,
  repositoryRoot: string,
  context: CliDiagnosticContext,
): void {
  const typedEnvelope = createTypedCliErrorEnvelope(error, repositoryRoot);
  if (typedEnvelope !== undefined) {
    process.stderr.write(`${JSON.stringify(typedEnvelope, null, 2)}\n`);
    return;
  }
  const identifiers = Object.entries(context.identifiers)
    .map(([name, value]) => ` ${name}=${value}`)
    .join("");
  process.stderr.write(
    `Provenance CLI error [command=${context.commandName}${identifiers}]: ${sanitizeError(error, repositoryRoot)}\n`,
  );
}

function createTypedCliErrorEnvelope(
  error: unknown,
  repositoryRoot: string,
): CliErrorEnvelope | undefined {
  if (error instanceof ProvenanceLedgerRecoveryBlockedError) {
    return {
      schemaVersion: 1,
      error: {
        code: "PROVENANCE_LEDGER_RECOVERY_BLOCKED",
        cause: recoveryBlockedCause(error),
        message: sanitizeError(error, repositoryRoot),
        details: projectProvenanceStructuredOutput(error.result, {
          projectRoot: repositoryRoot,
        }),
        nextAction: error.result.nextAction,
      },
    };
  }
  if (error instanceof ProvenanceLedgerRecoveryOperationError) {
    return {
      schemaVersion: 1,
      error: {
        code: error.code,
        cause: error.stage,
        message: sanitizeError(error, repositoryRoot),
        details: projectProvenanceStructuredOutput(
          { stage: error.stage, evidence: error.evidence },
          { projectRoot: repositoryRoot },
        ),
        nextAction: recoveryOperationNextAction(error.stage),
      },
    };
  }
  if (error instanceof ProvenanceLedgerSchemaDriftError) {
    const markerPresent = error.inspection.recoveryMarkerPresent;
    return {
      schemaVersion: 1,
      error: {
        code: "PROVENANCE_LEDGER_SCHEMA_DRIFT",
        cause: markerPresent ? "active-recovery-marker" : "schema-drift",
        message: sanitizeError(error, repositoryRoot),
        details: projectProvenanceStructuredOutput(error.inspection, {
          projectRoot: repositoryRoot,
        }),
        nextAction: markerPresent
          ? {
              code: "wait-inspect-retry",
              command: "ledger-status",
              message:
                "Wait for the active recovery to finish, inspect ledger status, then retry without deleting recovery markers.",
            }
          : {
              code: "preview-recovery",
              command: "recover-ledger",
              message:
                "Preview the JSONL-backed ledger recovery before applying it.",
            },
      },
    };
  }
  return undefined;
}

function recoveryOperationNextAction(
  stage: ProvenanceLedgerRecoveryOperationStage,
): CliNextAction {
  if (stage === "catch-up" || stage === "final-inspection") {
    return {
      code: "resume-recovery",
      command: "recover-ledger",
      message:
        "Preserve adjacent recovery evidence, inspect ledger status, then rerun recover-ledger --apply to resume safely.",
    };
  }
  return {
    code: "inspect-retry-recovery",
    command: "ledger-status",
    message:
      "Preserve adjacent archive and marker evidence, inspect ledger status, then retry or resume recover-ledger --apply.",
  };
}

function recoveryBlockedCause(
  error: ProvenanceLedgerRecoveryBlockedError,
): CliErrorCause {
  const result = error.result;
  if (result.archive !== undefined || result.replayedEventCount > 0) {
    return "post-swap-replay";
  }
  if (result.before.recoveryMarkerPresent || !result.recoveryMarkerCleared) {
    return "active-recovery-marker";
  }
  if (result.replay.issueCount > 0) return "pre-mutation-replay";
  return "interrupted-recovery";
}

function sanitizeError(error: unknown, repositoryRoot: string): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : error;
  return sanitizeProvenanceDiagnosticMessage(source, {
    projectRoot: repositoryRoot,
    fallback: "Unexpected provenance CLI failure",
  });
}

function writeJson(value: unknown, repositoryRoot?: string): void {
  const output =
    repositoryRoot === undefined
      ? value
      : projectProvenanceStructuredOutput(value, { projectRoot: repositoryRoot });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const executedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (executedPath === import.meta.url) {
  const exitCode = await runProvenanceCli(process.argv.slice(2), process.stdin);
  process.exitCode = exitCode;
}
