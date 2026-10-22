import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ClaudeCodeProvenanceEventNormalizer } from "../claude-code-provenance-adapter.js";
import { CodexProvenanceEventNormalizer } from "../codex-provenance-adapter.js";
import {
  ClaudeCodeProvenanceEventNameSchema,
  CodexProvenanceEventNameSchema,
  ProvenanceCaptureConfigSchema,
} from "../provenance-schemas.js";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const provenanceRoot = join(projectRoot, ".agents", "provenance");

const LEGACY_CLAUDE_EVENTS = [
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

const LEGACY_CODEX_EVENTS = [
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

const LEGACY_QUERY_COMMANDS = {
  failures: "listFailures",
  "agent-summary": "summarizeAgents",
  search: "search",
  similar: "findSimilar",
  patterns: "findPatterns",
} as const;

const JUSTIFIED_MVP_INSPECTION_COMMANDS = {
  sessions: "listSessions",
  events: "listEvents",
  export: "exportEvents",
} as const;

const EXPLICIT_MVP_INDEX_COMMAND = "index" as const;

const BOUNDED_RECOVERY_COMMANDS = ["ledger-status", "recover-ledger"] as const;

const JSONL_FIRST = [
  "await jsonlMirror.append(redactedEvent)",
  "new ProvenanceLedgerWriter(ledgerPath)",
] as const;

function readProjectFile(...segments: string[]): string {
  return readFileSync(join(projectRoot, ...segments), "utf8");
}

function configuredCapture() {
  return ProvenanceCaptureConfigSchema.parse(
    JSON.parse(
      readProjectFile(".agents", "provenance", "provenance.config.json"),
    ) as unknown,
  );
}

function claudeSettingsProvenanceEvents(): string[] {
  const settings = JSON.parse(readProjectFile(".claude", "settings.json")) as {
    hooks: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>>;
  };
  return Object.entries(settings.hooks)
    .filter(([, registrations]) =>
      registrations.some((registration) =>
        registration.hooks.some((hook) =>
          hook.args?.some((argument) =>
            argument.endsWith("/.claude/hooks/provenance.ts"),
          ),
        ),
      ),
    )
    .map(([eventName]) => eventName);
}

function codexConfigProvenanceEvents(): string[] {
  const source = readProjectFile(".codex", "config.toml");
  const events: string[] = [];
  let currentEvent: string | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const eventHeading = /^\[\[hooks\.([A-Za-z]+)\]\]$/u.exec(line);
    if (eventHeading?.[1] !== undefined) currentEvent = eventHeading[1];
    if (
      currentEvent !== undefined &&
      line.includes("/.codex/hooks/provenance.ts")
    ) {
      events.push(currentEvent);
    }
  }
  return events;
}

function registeredCliCommands(): string[] {
  const source = readProjectFile(".agents", "provenance", "provenance-cli.ts");
  return [...source.matchAll(/\.command\("([a-z-]+)"\)/gu)]
    .map((match) => match[1])
    .filter((command): command is string => command !== undefined);
}

test("preserves the exact ten Codex and eleven Claude capture events", () => {
  const config = configuredCapture();
  const recordedAt = "2026-07-20T00:00:00.000Z";
  const hookPayload = (eventName: string) => ({
    session_id: "parity-session",
    cwd: projectRoot,
    hook_event_name: eventName,
  });

  assert.equal(LEGACY_CLAUDE_EVENTS.length, 11);
  assert.deepEqual(config.captureEvents["claude-code"], LEGACY_CLAUDE_EVENTS);
  assert.deepEqual(
    ClaudeCodeProvenanceEventNameSchema.options,
    LEGACY_CLAUDE_EVENTS,
  );
  assert.deepEqual(claudeSettingsProvenanceEvents(), LEGACY_CLAUDE_EVENTS);
  assert.deepEqual(
    LEGACY_CLAUDE_EVENTS.map(
      (eventName) =>
        new ClaudeCodeProvenanceEventNormalizer().normalize(
          hookPayload(eventName),
          recordedAt,
        ).eventName,
    ),
    LEGACY_CLAUDE_EVENTS,
  );

  assert.equal(LEGACY_CODEX_EVENTS.length, 10);
  assert.deepEqual(config.captureEvents.codex, LEGACY_CODEX_EVENTS);
  assert.deepEqual(CodexProvenanceEventNameSchema.options, LEGACY_CODEX_EVENTS);
  assert.deepEqual(codexConfigProvenanceEvents(), LEGACY_CODEX_EVENTS);
  assert.deepEqual(
    LEGACY_CODEX_EVENTS.map(
      (eventName) =>
        new CodexProvenanceEventNormalizer().normalize(
          hookPayload(eventName),
          recordedAt,
        ).eventName,
    ),
    LEGACY_CODEX_EVENTS,
  );
});

test("preserves five legacy and four MVP query/index commands while adding two bounded recovery commands", () => {
  const contractsSource = readProjectFile(
    ".agents",
    "provenance",
    "provenance-contracts.ts",
  );
  const cliCommands = registeredCliCommands();
  const legacyEntries = Object.entries(LEGACY_QUERY_COMMANDS);
  const inspectionEntries = Object.entries(JUSTIFIED_MVP_INSPECTION_COMMANDS);

  assert.equal(legacyEntries.length, 5);
  assert.equal(inspectionEntries.length, 3);
  assert.equal(inspectionEntries.length + 1, 4);
  for (const [commandName, serviceMethod] of [
    ...legacyEntries,
    ...inspectionEntries,
  ]) {
    assert.equal(cliCommands.includes(commandName), true, commandName);
    assert.match(
      contractsSource,
      new RegExp(`\\b${serviceMethod}\\(`, "u"),
      serviceMethod,
    );
  }
  assert.deepEqual(cliCommands, [
    ...Object.keys(LEGACY_QUERY_COMMANDS),
    ...Object.keys(JUSTIFIED_MVP_INSPECTION_COMMANDS),
    EXPLICIT_MVP_INDEX_COMMAND,
    ...BOUNDED_RECOVERY_COMMANDS,
  ]);
});

test("keeps general verify repair spool and provenance control absent", () => {
  const config = configuredCapture();
  const captureSource = readProjectFile(
    ".agents",
    "provenance",
    "capture-provenance-event.ts",
  );
  const indexSource = readProjectFile(
    ".agents",
    "provenance",
    "embed-provenance-events.ts",
  );
  const ledgerSource = readProjectFile(
    ".agents",
    "provenance",
    "write-provenance-ledger.ts",
  );
  const ledgerDefinitionSource = readProjectFile(
    ".agents",
    "provenance",
    "provenance-ledger-definition.ts",
  );
  const packageJson = JSON.parse(
    readProjectFile(".agents", "provenance", "package.json"),
  ) as { scripts: Record<string, string> };

  assert.match(config.paths.ledger, /^\.agents\/data\/provenance\//u);
  assert.match(config.paths.jsonlDirectory, /^\.agents\/data\/provenance\//u);
  assert.notEqual(config.paths.ledger, config.paths.jsonlDirectory);
  assert.ok(captureSource.indexOf(JSONL_FIRST[0]) >= 0);
  assert.ok(
    captureSource.indexOf(JSONL_FIRST[0]) <
      captureSource.indexOf(JSONL_FIRST[1]),
  );

  assert.equal(config.embeddings.runInsideCaptureHook, false);
  assert.equal(packageJson.scripts.index, "tsx provenance-cli.ts index");
  assert.match(indexSource, /WHERE vectorized = 0\s+ORDER BY sequence ASC/u);
  assert.doesNotMatch(
    indexSource.match(
      /SELECT event_id, redacted_event_json[\s\S]*?LIMIT \?/u,
    )?.[0] ?? "",
    /event_name/u,
  );

  const tables = [
    ...ledgerDefinitionSource.matchAll(
      /CREATE TABLE IF NOT EXISTS ([a-z_]+)/gu,
    ),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(tables, ["provenance_embeddings", "provenance_events"]);
  assert.match(ledgerSource, /createCurrentProvenanceLedgerSchema/u);
  assert.doesNotMatch(
    ledgerSource,
    /CREATE TABLE IF NOT EXISTS provenance_(?:events|embeddings)/u,
  );
  assert.equal(
    existsSync(join(provenanceRoot, "spool-provenance-recovery.ts")),
    false,
  );

  const excludedCommandNames = ["verify", "repair", "spool", "control"];
  assert.deepEqual(
    registeredCliCommands().filter((command) =>
      excludedCommandNames.includes(command),
    ),
    [],
  );
  assert.doesNotMatch(
    ledgerDefinitionSource,
    /CREATE TABLE IF NOT EXISTS provenance_(?:integrity|recovery|control)/u,
  );
  assert.doesNotMatch(ledgerSource, /provenance_(?:integrity|control)/u);
});
