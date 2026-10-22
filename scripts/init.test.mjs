import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  PROJECT_ROOT,
  TEMP_DIR,
  USER_HOME,
  buildDependencyInstallPlan,
  buildProvenanceLedgerInitInvocation,
  compareSemanticVersions,
  deployClaudeLocalSettings,
  formatInitializationCommandFailure,
  listWorkspaceHygieneWarnings,
  offerClaudeLocalSettings,
  parseSemanticVersion,
  runInitializationCommand,
  tokenizeInitializerOutput,
} from "./init.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const provenanceConfigSource = join(
  projectRoot,
  ".agents",
  "provenance",
  "provenance.config.json",
);

async function createProvenanceFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `propel-init-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(
    root,
    ".agents",
    "provenance",
    "provenance.config.json",
  );
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, readFileSync(provenanceConfigSource));
  return root;
}

function invokeFixture(root, checkOnly) {
  const invocation = buildProvenanceLedgerInitInvocation(projectRoot, checkOnly);
  return spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: { ...process.env, PROVENANCE_PROJECT_ROOT: root },
    shell: false,
  });
}

function invokeFixtureThroughInitializerRunner(root, checkOnly) {
  const invocation = buildProvenanceLedgerInitInvocation(projectRoot, checkOnly);
  const phase = checkOnly
    ? "provenance ledger readiness check"
    : "provenance ledger recovery";
  const script = `
    import {
      runInitializationCommand,
      tokenizeInitializerOutput,
    } from ${JSON.stringify(new URL("./init.mjs", import.meta.url).href)};
    try {
      runInitializationCommand(
        ${JSON.stringify(invocation.command)},
        ${JSON.stringify(invocation.args)},
        { cwd: ${JSON.stringify(invocation.cwd)}, phase: ${JSON.stringify(phase)} },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("\\nInitialization failed: " + tokenizeInitializerOutput(message));
      process.exitCode = 1;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, PROVENANCE_PROJECT_ROOT: root },
    shell: false,
  });
}

function parseFixtureOutput(result) {
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout);
}

function fixtureEvent(eventId, detail = "updated file") {
  return {
    schemaVersion: 1,
    eventId,
    recordedAt: "2026-07-20T00:00:01.000Z",
    harness: "claude-code",
    eventName: "PostToolUse",
    sessionId: "session-init",
    workflowId: "workflow-init",
    source: "agent-init",
    role: "agent",
    agentId: "agent-init",
    agentType: "builder",
    toolName: "Edit",
    cwd: PROJECT_ROOT,
    eventData: { tool_response: detail },
    redactionCount: 0,
    truncatedFields: [],
    contentSha256: createHash("sha256").update(`${eventId}:${detail}`).digest("hex"),
  };
}

async function createLegacyFixture(t, name, jsonlLines) {
  const root = await createProvenanceFixture(t, name);
  const ledgerPath = join(root, ".agents", "data", "provenance", "provenance.db");
  const jsonlPath = join(
    root,
    ".agents",
    "data",
    "provenance",
    "jsonl",
    "claude-code",
    "session-init.jsonl",
  );
  await mkdir(dirname(ledgerPath), { recursive: true });
  await mkdir(dirname(jsonlPath), { recursive: true });
  const database = new Database(ledgerPath);
  database.exec(`
    CREATE TABLE provenance_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_payload TEXT NOT NULL
    );
    PRAGMA user_version = 0;
  `);
  database.close();
  await writeFile(jsonlPath, `${jsonlLines.join("\n")}\n`, "utf8");
  return { root, ledgerPath, jsonlPath };
}

async function createObservedPartialFixture(t) {
  const root = await createProvenanceFixture(t, "observed-partial");
  const ledgerPath = join(root, ".agents", "data", "provenance", "provenance.db");
  const jsonlDirectory = join(
    root,
    ".agents",
    "data",
    "provenance",
    "jsonl",
  );
  await mkdir(dirname(ledgerPath), { recursive: true });
  const database = new Database(ledgerPath);
  database.exec(`
    CREATE TABLE provenance_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_payload TEXT NOT NULL
    );
    PRAGMA user_version = 0;
  `);
  database.close();

  const jsonlBytes = new Map();
  let validEventCount = 0;
  let invalidRecordCount = 0;
  for (let fileIndex = 0; fileIndex < 7; fileIndex += 1) {
    const validLineCount = fileIndex < 5 ? 20 : 19;
    const lines = [];
    for (let lineIndex = 0; lineIndex < 45; lineIndex += 1) {
      if (lineIndex < validLineCount) {
        validEventCount += 1;
        const hex = validEventCount.toString(16).padStart(8, "0");
        const eventId = `${hex}-0000-4000-8000-${hex.padStart(12, "0")}`;
        lines.push(JSON.stringify({
          ...fixtureEvent(eventId, `observed event ${validEventCount}`),
          recordedAt: new Date(
            Date.UTC(2026, 6, 20, 12, 0, validEventCount),
          ).toISOString(),
        }));
      } else {
        invalidRecordCount += 1;
        lines.push(`legacy-record-${invalidRecordCount}`);
      }
    }
    const jsonlPath = join(
      jsonlDirectory,
      fileIndex % 2 === 0 ? "codex" : "claude-code",
      `observed-${fileIndex + 1}.jsonl`,
    );
    await mkdir(dirname(jsonlPath), { recursive: true });
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    await writeFile(jsonlPath, bytes);
    jsonlBytes.set(jsonlPath, bytes);
  }
  assert.equal(validEventCount, 138);
  assert.equal(invalidRecordCount, 177);
  return { root, ledgerPath, jsonlBytes };
}

async function findArchiveDirectory(ledgerPath) {
  const prefix = `${basename(ledgerPath)}.archive-`;
  const archiveName = (await readdir(dirname(ledgerPath))).find((entry) =>
    entry.startsWith(prefix),
  );
  assert.ok(archiveName, "expected a recovery archive directory");
  return join(dirname(ledgerPath), archiveName);
}

test("parseSemanticVersion accepts Node, npm, and Claude version output", () => {
  assert.deepEqual(parseSemanticVersion("v22.22.0"), [22, 22, 0]);
  assert.deepEqual(parseSemanticVersion("11.6.2"), [11, 6, 2]);
  assert.deepEqual(parseSemanticVersion("2.1.215 (Claude Code)"), [2, 1, 215]);
  assert.equal(parseSemanticVersion("not a version"), undefined);
});

test("compareSemanticVersions enforces version floors", () => {
  assert.equal(compareSemanticVersions([22, 0, 0], [22, 0, 0]), 0);
  assert.equal(compareSemanticVersions([22, 1, 0], [22, 0, 0]), 1);
  assert.equal(compareSemanticVersions([21, 99, 99], [22, 0, 0]), -1);
});

test("dependency plan installs every locked package for the active platform", () => {
  const root = join("fixture", "Spark ADW");
  const plan = buildDependencyInstallPlan(root, "linux");

  assert.deepEqual(plan.map((step) => step.cwd), [
    root,
    join(root, ".claude", "compatibility"),
    join(root, ".agents", "provenance"),
  ]);
  assert.deepEqual(plan.map((step) => step.args), [
    ["ci", "--os=linux"],
    ["ci", "--os=linux"],
    ["ci", "--os=linux"],
  ]);
});

test("deploys the Claude local settings sample only for affirmative responses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "propel-init-settings-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeDirectory = join(root, ".claude");
  const samplePath = join(claudeDirectory, "settings.local.example.json");
  const destinationPath = join(claudeDirectory, "settings.local.json");
  const sampleBytes = Buffer.from('{"permissions":{"allow":["Read"]}}\n');
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(samplePath, sampleBytes);

  assert.equal(deployClaudeLocalSettings(root, "n"), "declined");
  assert.equal(existsSync(destinationPath), false);
  assert.equal(deployClaudeLocalSettings(root, " y "), "copied");
  assert.deepEqual(await readFile(destinationPath), sampleBytes);
});

test("preserves existing Claude local settings without prompting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "propel-init-settings-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeDirectory = join(root, ".claude");
  const destinationPath = join(claudeDirectory, "settings.local.json");
  const existingBytes = Buffer.from('{"permissions":{"allow":["Bash"]}}\n');
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(
    join(claudeDirectory, "settings.local.example.json"),
    '{"permissions":{"allow":["Read"]}}\n',
  );
  await writeFile(destinationPath, existingBytes);
  let prompted = false;

  const result = await offerClaudeLocalSettings(root, {
    input: { isTTY: true },
    prompt: async () => {
      prompted = true;
      return "y";
    },
  });

  assert.equal(result, "existing");
  assert.equal(prompted, false);
  assert.deepEqual(await readFile(destinationPath), existingBytes);
});

test("skips the local settings prompt for non-interactive input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "propel-init-settings-noninteractive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeDirectory = join(root, ".claude");
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(
    join(claudeDirectory, "settings.local.example.json"),
    '{"permissions":{"allow":["Read"]}}\n',
  );
  let prompted = false;

  const result = await offerClaudeLocalSettings(root, {
    input: { isTTY: false },
    prompt: async () => {
      prompted = true;
      return "y";
    },
  });

  assert.equal(result, "non-interactive");
  assert.equal(prompted, false);
  assert.equal(
    existsSync(join(claudeDirectory, "settings.local.json")),
    false,
  );
});

test("lists stray top-level entries and ignores tracked and generated ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "propel-init-hygiene-stray-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trackedTopLevelEntries = ["scripts", "package.json"];
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "package.json"), "{}\n");
  await mkdir(join(root, "2026-10-17-feature"));
  await mkdir(join(root, "node_modules"));

  assert.deepEqual(listWorkspaceHygieneWarnings(root, trackedTopLevelEntries), [
    "2026-10-17-feature",
  ]);
});

test("reports no hygiene warnings for a root holding only tracked entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "propel-init-hygiene-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trackedTopLevelEntries = ["scripts", "package.json"];
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "package.json"), "{}\n");

  assert.deepEqual(listWorkspaceHygieneWarnings(root, trackedTopLevelEntries), []);
});

test("tokenizes initializer-owned Windows and POSIX project home and temp paths", () => {
  const windowsPaths = {
    projectRoot: "D:\\Work\\Propel-ADW",
    userHome: "C:\\Users\\operator",
    temporaryDirectory: "C:\\Users\\operator\\AppData\\Local\\Temp",
  };
  const windowsOutput = tokenizeInitializerOutput(
    "D:\\Work\\Propel-ADW\\scripts /mnt/d/Work/Propel-ADW/scripts " +
      "C:\\Users\\operator\\private C:\\Users\\operator\\AppData\\Local\\Temp\\run",
    windowsPaths,
  );
  assert.match(windowsOutput, /<PROJECT_ROOT>/u);
  assert.match(windowsOutput, /<USER_HOME>/u);
  assert.match(windowsOutput, /<TEMP_DIR>/u);
  assert.equal(windowsOutput.includes("D:\\Work\\Propel-ADW"), false);
  assert.equal(windowsOutput.includes("/mnt/d/Work/Propel-ADW"), false);
  assert.equal(windowsOutput.includes("C:\\Users\\operator"), false);

  const posixRoot = "/srv/operator/propel-adw";
  const posixOutput = tokenizeInitializerOutput(
    `${posixRoot}/scripts /home/operator/private /tmp/propel-init/run`,
    {
      projectRoot: posixRoot,
      userHome: "/home/operator",
      temporaryDirectory: "/tmp",
    },
  );
  assert.equal(posixOutput.includes(posixRoot), false);
  assert.equal(posixOutput.includes("/home/operator"), false);
  assert.equal(posixOutput.includes("/tmp"), false);
  assert.match(posixOutput, /<PROJECT_ROOT>/u);
  assert.match(posixOutput, /<USER_HOME>/u);
  assert.match(posixOutput, /<TEMP_DIR>/u);
});

test("command failure wrappers retain phase and status without absolute invocation", () => {
  const windowsFailure = formatInitializationCommandFailure({
    phase: "provenance ledger recovery",
    command: "C:\\Users\\operator\\bin\\node.exe",
    status: 17,
  });
  assert.equal(
    windowsFailure,
    'Phase "provenance ledger recovery" failed (node.exe, exit status 17).',
  );
  assert.equal(windowsFailure.includes("C:\\Users\\operator"), false);

  const posixSpawnFailure = formatInitializationCommandFailure({
    phase: "provenance ledger readiness check",
    command: "/home/operator/bin/node",
    started: false,
  });
  assert.equal(
    posixSpawnFailure,
    'Phase "provenance ledger readiness check" could not start (node).',
  );
  assert.equal(posixSpawnFailure.includes("/home/operator"), false);
});

test("isolated command runner preserves success and blocks safe spawn and nonzero failures", () => {
  const success = runInitializationCommand(
    process.execPath,
    ["-e", "process.stdout.write('ready')"],
    { capture: true, phase: "synthetic success" },
  );
  assert.equal(success, "ready");

  const missingExecutable = join(tmpdir(), "propel-init-missing", "node.exe");
  assert.throws(
    () => runInitializationCommand(missingExecutable, [], {
      capture: true,
      phase: "synthetic spawn",
    }),
    (error) => {
      assert.match(error.message, /synthetic spawn/u);
      assert.equal(error.message.includes(missingExecutable), false);
      return true;
    },
  );

  const sensitiveArgument = join(homedir(), "private", "fixture.jsonl");
  assert.throws(
    () => runInitializationCommand(
      process.execPath,
      ["-e", "process.exit(9)", sensitiveArgument],
      { capture: true, phase: "synthetic nonzero" },
    ),
    (error) => {
      assert.match(error.message, /synthetic nonzero/u);
      assert.match(error.message, /exit status 9/u);
      assert.equal(error.message.includes(process.execPath), false);
      assert.equal(error.message.includes(sensitiveArgument), false);
      return true;
    },
  );
});

test("builds ledger-status for check-only initialization", () => {
  const root = join("fixture", "Spark ADW");
  assert.deepEqual(buildProvenanceLedgerInitInvocation(root, true), {
    command: process.execPath,
    args: [
      join(root, ".agents", "provenance", "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, ".agents", "provenance", "provenance-cli.ts"),
      "ledger-status",
      "--require-ready",
    ],
    cwd: root,
  });
});

test("builds recover-ledger --apply for normal initialization", () => {
  const root = join("fixture", "Spark ADW");
  assert.deepEqual(buildProvenanceLedgerInitInvocation(root, false), {
    command: process.execPath,
    args: [
      join(root, ".agents", "provenance", "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, ".agents", "provenance", "provenance-cli.ts"),
      "recover-ledger",
      "--apply",
    ],
    cwd: root,
  });
});

test("rejects incompatible status without mutating the target", async (t) => {
  const root = await createProvenanceFixture(t, "incompatible");
  const ledgerPath = join(root, ".agents", "data", "provenance", "provenance.db");
  await mkdir(dirname(ledgerPath), { recursive: true });
  const database = new Database(ledgerPath);
  database.exec(`
    CREATE TABLE provenance_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_payload TEXT NOT NULL
    );
    PRAGMA user_version = 0;
  `);
  database.close();
  const before = await readFile(ledgerPath);

  const result = invokeFixture(root, true);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.error.code, "PROVENANCE_LEDGER_SCHEMA_DRIFT");
  assert.equal(envelope.error.details.state, "incompatible");
  assert.match(envelope.error.details.databasePath, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(result.stderr.includes(root), false);
  assert.deepEqual(await readFile(ledgerPath), before);
  assert.equal(existsSync(`${ledgerPath}-wal`), false);
  assert.equal(existsSync(`${ledgerPath}-shm`), false);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(dirname(ledgerPath), "models")), false);
});

test("normal mode rebuilds an isolated legacy ledger and streams tokenized evidence", async (t) => {
  const event = fixtureEvent("00000000-0000-4000-8000-000000000101");
  const { root, ledgerPath, jsonlPath } = await createLegacyFixture(
    t,
    "legacy-rebuild",
    [JSON.stringify(event)],
  );
  const legacyBytes = await readFile(ledgerPath);
  const jsonlBytes = await readFile(jsonlPath);

  const result = invokeFixtureThroughInitializerRunner(root, false);

  assert.equal(result.status, 0, result.stderr);
  const recovery = parseFixtureOutput(result);
  assert.equal(recovery.mode, "apply");
  assert.equal(recovery.status, "rebuilt");
  assert.equal(recovery.after.state, "current");
  assert.equal(recovery.replayedEventCount, 1);
  assert.equal(recovery.semanticReindexRequired, true);
  assert.match(recovery.archive.directory, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stderr.includes(root), false);
  assert.deepEqual(await readFile(jsonlPath), jsonlBytes);
  assert.notDeepEqual(await readFile(ledgerPath), legacyBytes);
  const archiveDirectory = await findArchiveDirectory(ledgerPath);
  assert.deepEqual(
    await readFile(join(archiveDirectory, basename(ledgerPath))),
    legacyBytes,
  );
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(dirname(ledgerPath), "models")), false);
});

test("check-only preserves and normal mode recovers the exact observed partial corpus", async (t) => {
  const { root, ledgerPath, jsonlBytes } = await createObservedPartialFixture(t);
  const legacyBytes = await readFile(ledgerPath);

  const checkOnly = invokeFixture(root, true);
  assert.equal(checkOnly.status, 1);
  assert.equal(checkOnly.stdout, "");
  const checkEnvelope = JSON.parse(checkOnly.stderr);
  assert.equal(checkEnvelope.error.code, "PROVENANCE_LEDGER_SCHEMA_DRIFT");
  assert.equal(checkEnvelope.error.details.state, "incompatible");
  assert.deepEqual(await readFile(ledgerPath), legacyBytes);
  for (const [jsonlPath, beforeBytes] of jsonlBytes) {
    assert.deepEqual(await readFile(jsonlPath), beforeBytes);
  }
  assert.equal(
    (await readdir(dirname(ledgerPath))).some((entry) =>
      entry.startsWith(`${basename(ledgerPath)}.archive-`),
    ),
    false,
  );
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(dirname(ledgerPath), "models")), false);

  const normal = invokeFixtureThroughInitializerRunner(root, false);
  assert.equal(normal.status, 0, normal.stderr);
  const recovery = parseFixtureOutput(normal);
  assert.equal(recovery.status, "rebuilt");
  assert.equal(recovery.replayedEventCount, 138);
  assert.equal(recovery.replay.jsonlFileCount, 7);
  assert.equal(recovery.replay.nonBlankLineCount, 315);
  assert.equal(recovery.replay.validEventCount, 138);
  assert.equal(recovery.replay.invalidRecordCount, 177);
  assert.equal(recovery.replay.conflictingEventCount, 0);
  assert.equal(recovery.replay.disposition, "partial");
  assert.equal(recovery.replay.skippedIssueCount, 177);
  assert.equal(recovery.replay.blockingIssueCount, 0);
  assert.equal(recovery.nextAction.code, "review-skipped-replay-evidence");
  assert.equal(recovery.nextAction.command, undefined);
  assert.equal(recovery.semanticReindexRequired, true);
  assert.match(recovery.archive.directory, /^<PROJECT_ROOT>[\\/]/u);
  assert.equal(normal.stdout.includes(root), false);
  assert.equal(normal.stderr.includes(root), false);
  assert.notDeepEqual(await readFile(ledgerPath), legacyBytes);
  for (const [jsonlPath, beforeBytes] of jsonlBytes) {
    assert.deepEqual(await readFile(jsonlPath), beforeBytes);
  }
  const archiveDirectory = await findArchiveDirectory(ledgerPath);
  assert.deepEqual(
    await readFile(join(archiveDirectory, basename(ledgerPath))),
    legacyBytes,
  );
  const recovered = new Database(ledgerPath, { readonly: true });
  try {
    assert.equal(
      recovered.prepare("SELECT COUNT(*) FROM provenance_events").pluck().get(),
      138,
    );
    assert.equal(
      recovered.prepare("SELECT COUNT(*) FROM provenance_events WHERE vectorized = 0").pluck().get(),
      138,
    );
  } finally {
    recovered.close();
  }
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(dirname(ledgerPath), "models")), false);
});

test("normal mode blocks invalid conflicting replay with structured tokenized evidence", async (t) => {
  const eventId = "00000000-0000-4000-8000-000000000102";
  const first = fixtureEvent(eventId, "first version");
  const conflicting = fixtureEvent(eventId, "conflicting version");
  const { root, ledgerPath, jsonlPath } = await createLegacyFixture(
    t,
    "blocked-replay",
    [JSON.stringify(first), "{invalid-json", JSON.stringify(conflicting)],
  );
  const ledgerBytes = await readFile(ledgerPath);
  const jsonlBytes = await readFile(jsonlPath);

  const result = invokeFixtureThroughInitializerRunner(root, false);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const wrapperStart = result.stderr.lastIndexOf("\nInitialization failed:");
  assert.ok(wrapperStart > 0, result.stderr);
  const envelope = JSON.parse(result.stderr.slice(0, wrapperStart));
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.error.code, "PROVENANCE_LEDGER_RECOVERY_BLOCKED");
  assert.equal(envelope.error.cause, "pre-mutation-replay");
  assert.equal(envelope.error.nextAction.code, "correct-replay-evidence");
  assert.ok(envelope.error.details.replay.issueCount >= 2);
  assert.match(JSON.stringify(envelope), /<PROJECT_ROOT>/u);
  assert.equal(result.stderr.includes(root), false);
  const wrapper = result.stderr.slice(wrapperStart);
  assert.match(wrapper, /provenance ledger recovery/u);
  assert.match(wrapper, /exit status 1/u);
  assert.equal(wrapper.includes(process.execPath), false);
  assert.equal(wrapper.includes("recover-ledger"), false);
  assert.deepEqual(await readFile(ledgerPath), ledgerBytes);
  assert.deepEqual(await readFile(jsonlPath), jsonlBytes);
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(
    (await readdir(dirname(ledgerPath))).some((entry) =>
      entry.startsWith(`${basename(ledgerPath)}.archive-`),
    ),
    false,
  );
});

test("accepts missing and current status then runs existing verification", async (t) => {
  const root = await createProvenanceFixture(t, "ready-states");
  const ledgerPath = join(root, ".agents", "data", "provenance", "provenance.db");
  const missingResult = invokeFixture(root, true);
  assert.equal(missingResult.status, 0, missingResult.stderr);
  assert.equal(parseFixtureOutput(missingResult).state, "missing");
  assert.equal(existsSync(ledgerPath), false);
  assert.equal(existsSync(dirname(ledgerPath)), false);

  const recoveryResult = invokeFixture(root, false);
  assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
  assert.equal(parseFixtureOutput(recoveryResult).status, "created");
  const currentBytes = await readFile(ledgerPath);
  const walPath = `${ledgerPath}-wal`;
  const shmPath = `${ledgerPath}-shm`;
  const currentWalBytes = existsSync(walPath) ? await readFile(walPath) : undefined;
  const currentShmBytes = existsSync(shmPath) ? await readFile(shmPath) : undefined;

  const currentResult = invokeFixture(root, true);
  assert.equal(currentResult.status, 0, currentResult.stderr);
  assert.equal(parseFixtureOutput(currentResult).state, "current");
  assert.deepEqual(await readFile(ledgerPath), currentBytes);
  assert.equal(existsSync(walPath), currentWalBytes !== undefined);
  assert.equal(existsSync(shmPath), currentShmBytes !== undefined);
  if (currentWalBytes !== undefined) {
    assert.deepEqual(await readFile(walPath), currentWalBytes);
  }
  if (currentShmBytes !== undefined) {
    assert.deepEqual(await readFile(shmPath), currentShmBytes);
  }
  assert.equal(existsSync(`${ledgerPath}.recovery.lock`), false);
  assert.equal(existsSync(join(dirname(ledgerPath), "models")), false);

  const source = await readFile(join(scriptDirectory, "init.mjs"), "utf8");
  const ledgerGateCall = source.lastIndexOf(
    "verifyOrRecoverProvenanceLedger(checkOnly);",
  );
  const verificationCall = source.lastIndexOf("runVerification();");
  assert.ok(ledgerGateCall >= 0);
  assert.ok(verificationCall > ledgerGateCall);
});
