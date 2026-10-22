#!/usr/bin/env node

import {
  constants as fileSystemConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const minimumNodeVersion = Object.freeze([22, 0, 0]);
export const minimumClaudeVersion = Object.freeze([2, 1, 214]);
export const PROJECT_ROOT = "<PROJECT_ROOT>";
export const USER_HOME = "<USER_HOME>";
export const TEMP_DIR = "<TEMP_DIR>";
export const CLAUDE_LOCAL_SETTINGS_SAMPLE = join(
  ".claude",
  "settings.local.example.json",
);
export const CLAUDE_LOCAL_SETTINGS = join(".claude", "settings.local.json");
export const WORKSPACE_HYGIENE_ALLOWLIST = Object.freeze([
  ".git",
  "node_modules",
  ".vercel",
  ".next",
  "dist",
  "build",
  "coverage",
  ".DS_Store",
  "Thumbs.db",
]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

export function parseSemanticVersion(value) {
  const match = String(value).match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+()])/u);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function buildDependencyInstallPlan(root, platform = process.platform) {
  return [
    {
      label: "ADW runtime dependencies",
      cwd: root,
      args: ["ci", `--os=${platform}`],
    },
    {
      label: "Claude compatibility dependencies",
      cwd: join(root, ".claude", "compatibility"),
      args: ["ci", `--os=${platform}`],
    },
    {
      label: "provenance dependencies",
      cwd: join(root, ".agents", "provenance"),
      args: ["ci", `--os=${platform}`],
    },
  ];
}

export function buildProvenanceLedgerInitInvocation(root, checkOnly) {
  const provenanceRoot = join(root, ".agents", "provenance");
  return {
    command: process.execPath,
    args: [
      join(provenanceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      join(provenanceRoot, "provenance-cli.ts"),
      ...(checkOnly
        ? ["ledger-status", "--require-ready"]
        : ["recover-ledger", "--apply"]),
    ],
    cwd: root,
  };
}

export function deployClaudeLocalSettings(root, response) {
  const sourcePath = join(root, CLAUDE_LOCAL_SETTINGS_SAMPLE);
  const destinationPath = join(root, CLAUDE_LOCAL_SETTINGS);
  if (existsSync(destinationPath)) return "existing";
  if (!/^(?:y|yes)$/iu.test(String(response).trim())) return "declined";
  copyFileSync(sourcePath, destinationPath, fileSystemConstants.COPYFILE_EXCL);
  return "copied";
}

export async function offerClaudeLocalSettings(root, options = {}) {
  const destinationPath = join(root, CLAUDE_LOCAL_SETTINGS);
  if (existsSync(destinationPath)) {
    console.log(`OK  Existing ${CLAUDE_LOCAL_SETTINGS} preserved.`);
    return "existing";
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true) {
    console.log(
      `SKIP ${CLAUDE_LOCAL_SETTINGS} was not deployed because input is non-interactive.`,
    );
    return "non-interactive";
  }

  const prompt = options.prompt ?? (async (question) => {
    const interfaceInstance = createInterface({ input, output });
    try {
      return await interfaceInstance.question(question);
    } finally {
      interfaceInstance.close();
    }
  });
  const response = await prompt(
    `Deploy ${CLAUDE_LOCAL_SETTINGS_SAMPLE} as ${CLAUDE_LOCAL_SETTINGS}? [y/N] `,
  );
  const result = deployClaudeLocalSettings(root, response);
  if (result === "copied") {
    console.log(`OK  Deployed ${CLAUDE_LOCAL_SETTINGS}.`);
  } else {
    console.log(`SKIP ${CLAUDE_LOCAL_SETTINGS} was not deployed.`);
  }
  return result;
}

function formatVersion(version) {
  return version.join(".");
}

export function tokenizeInitializerOutput(value, options = {}) {
  let output = String(value);
  const paths = [
    [options.projectRoot ?? projectRoot, PROJECT_ROOT],
    [options.userHome ?? homedir(), USER_HOME],
    [options.temporaryDirectory ?? tmpdir(), TEMP_DIR],
  ];
  const replacements = new Map();
  for (const [pathValue, token] of paths) {
    for (const variant of crossPlatformPathVariants(pathValue)) {
      if (variant.length > 0) replacements.set(variant, token);
    }
  }
  for (const [sourcePath, token] of [...replacements].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    output = output.split(sourcePath).join(token);
  }
  return output;
}

export function formatInitializationCommandFailure({
  phase,
  command,
  status,
  started = true,
}) {
  const commandIdentity = String(command).split(/[\\/]/u).at(-1) || "command";
  if (!started) {
    return `Phase "${phase}" could not start (${commandIdentity}).`;
  }
  return `Phase "${phase}" failed (${commandIdentity}, exit status ${status}).`;
}

export function runInitializationCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    stdio: options.capture === true ? "pipe" : "inherit",
  });

  if (result.error !== undefined) {
    throw new Error(formatInitializationCommandFailure({
      phase: options.phase ?? "command execution",
      command,
      started: false,
    }));
  }
  if (result.status !== 0) {
    throw new Error(formatInitializationCommandFailure({
      phase: options.phase ?? "command execution",
      command,
      status: result.status,
    }));
  }
  return String(result.stdout ?? "").trim();
}

export function listWorkspaceHygieneWarnings(root, trackedTopLevelEntries) {
  const tracked = new Set(trackedTopLevelEntries);
  return readdirSync(root)
    .filter(
      (name) =>
        !tracked.has(name) &&
        !WORKSPACE_HYGIENE_ALLOWLIST.includes(name) &&
        !name.startsWith(".env"),
    )
    .sort();
}

function listTrackedTopLevelEntries(root) {
  const result = spawnSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("/")[0]);
}

function warnAboutWorkspaceHygiene() {
  const tracked = listTrackedTopLevelEntries(projectRoot);
  if (tracked === undefined) return;
  for (const name of listWorkspaceHygieneWarnings(projectRoot, tracked)) {
    console.warn("WARN Unexpected top-level entry: " + name);
  }
}

function crossPlatformPathVariants(pathValue) {
  const normalized = String(pathValue);
  const variants = new Set([
    normalized,
    normalized.replaceAll("\\", "/"),
    normalized.replaceAll("/", "\\"),
  ]);
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/u.exec(normalized);
  if (driveMatch !== null) {
    variants.add(`/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replaceAll("\\", "/")}`);
  }
  const wslMatch = /^\/mnt\/([A-Za-z])\/(.*)$/u.exec(normalized.replaceAll("\\", "/"));
  if (wslMatch !== null) {
    variants.add(`${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`);
    variants.add(`${wslMatch[1].toUpperCase()}:\\${wslMatch[2].replaceAll("/", "\\")}`);
  }
  return variants;
}

const run = runInitializationCommand;

function runNpm(args, options = {}) {
  if (process.platform !== "win32") {
    return run("npm", args, { phase: "npm", ...options });
  }

  const npmCliPath = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(npmCliPath)) {
    throw new Error(`npm CLI was not found beside Node.js: ${npmCliPath}`);
  }
  return run(process.execPath, [npmCliPath, ...args], {
    phase: "npm",
    ...options,
  });
}

function verifyToolVersion(label, command, args, minimumVersion) {
  const output = run(command, args, {
    capture: true,
    phase: `${label} version check`,
  });
  const version = parseSemanticVersion(output);
  if (version === undefined) {
    throw new Error(`${label} returned an unrecognized version: ${output}`);
  }
  if (compareSemanticVersions(version, minimumVersion) < 0) {
    throw new Error(
      `${label} ${formatVersion(version)} is too old; ` +
        `${formatVersion(minimumVersion)} or newer is required.`,
    );
  }
  console.log(`OK  ${label} ${formatVersion(version)}`);
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME !== undefined) return true;
  try {
    return /microsoft/iu.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function verifyProjectShape() {
  const requiredFiles = [
    "package-lock.json",
    join(".claude", "compatibility", "package-lock.json"),
    join(".agents", "provenance", "package-lock.json"),
    join(".claude", "settings.json"),
    CLAUDE_LOCAL_SETTINGS_SAMPLE,
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(join(projectRoot, relativePath))) {
      throw new Error(`Required project file is missing: ${relativePath}`);
    }
  }
}

function verifyInstalledEntrypoints() {
  const requiredFiles = [
    join("node_modules", "tsx", "dist", "cli.mjs"),
    join(".claude", "compatibility", "node_modules", "tsx", "dist", "cli.mjs"),
    join(".agents", "provenance", "node_modules", "tsx", "dist", "cli.mjs"),
    join(".agents", "provenance", "node_modules", "better-sqlite3", "package.json"),
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(join(projectRoot, relativePath))) {
      throw new Error(`Dependency installation is incomplete: ${relativePath}`);
    }
  }
}

export function verifyOrRecoverProvenanceLedger(checkOnly) {
  const invocation = buildProvenanceLedgerInitInvocation(projectRoot, checkOnly);
  console.log(
    checkOnly
      ? "\nChecking provenance ledger readiness..."
      : "\nRecovering provenance ledger if required...",
  );
  run(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    phase: checkOnly
      ? "provenance ledger readiness check"
      : "provenance ledger recovery",
  });
}

function runVerification() {
  const hostInstall = process.env.PROPEL_ADW_HOST_INSTALL === "1";
  const compatibilityRoot = join(projectRoot, ".claude", "compatibility");
  const provenanceRoot = join(projectRoot, ".agents", "provenance");
  const compatibilityTsx = join(
    compatibilityRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const claudeTests = readdirSync(join(projectRoot, ".claude", "tests"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(projectRoot, ".claude", "tests", entry.name))
    .sort();

  console.log("\nVerifying Claude mirror contracts...");
  run(process.execPath, [
    compatibilityTsx,
    join(compatibilityRoot, "verify-claude-mirrors.ts"),
    "--identity-clean",
    ...(hostInstall ? ["--host-install"] : []),
  ], { phase: "Claude mirror verification" });
  runNpm(["run", "typecheck"], {
    cwd: compatibilityRoot,
    phase: "Claude compatibility typecheck",
  });
  run(process.execPath, [compatibilityTsx, "--test", ...claudeTests], {
    phase: "Claude compatibility tests",
  });

  console.log("\nVerifying provenance contracts...");
  runNpm(["run", "typecheck"], {
    cwd: provenanceRoot,
    phase: "provenance typecheck",
  });
  runNpm(["test"], { cwd: provenanceRoot, phase: "provenance tests" });

  console.log("\nVerifying initialization-script contracts...");
  run(process.execPath, ["--test", join(scriptDirectory, "init.test.mjs")], {
    phase: "initialization-script tests",
  });
}

function printHelp() {
  console.log(`Usage: node scripts/init.mjs [--check] [--host-install]\n\n` +
    "Without flags, installs locked dependencies for the current operating " +
    "system and runs all local compatibility and provenance checks.\n" +
    "--check skips installation and verifies the existing environment.\n" +
    "--host-install verifies an ADW installed into a host project, whose own " +
    "root package.json, package-lock.json and .gitignore are not ADW files.");
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const unknownArguments = argv.filter(
    (argument) => argument !== "--check" && argument !== "--host-install",
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
  }

  const checkOnly = argv.includes("--check");
  const hostInstall = argv.includes("--host-install");
  if (hostInstall) process.env.PROPEL_ADW_HOST_INSTALL = "1";
  console.log(`Initializing Propel-ADW at ${PROJECT_ROOT}`);
  verifyProjectShape();
  verifyToolVersion("Node.js", process.execPath, ["--version"], minimumNodeVersion);
  const npmVersionOutput = runNpm(["--version"], { capture: true });
  const npmVersion = parseSemanticVersion(npmVersionOutput);
  if (npmVersion === undefined || compareSemanticVersions(npmVersion, [10, 0, 0]) < 0) {
    throw new Error(`npm 10 or newer is required; received ${npmVersionOutput}`);
  }
  console.log(`OK  npm ${formatVersion(npmVersion)}`);
  verifyToolVersion("Claude Code", "claude", ["--version"], minimumClaudeVersion);
  console.log("\nChecking Claude Code installation and settings...");
  run("claude", ["doctor"], { phase: "Claude Code doctor" });

  if (isWsl() && projectRoot.startsWith("/mnt/")) {
    console.warn(
      "WARN This checkout is on a Windows-mounted drive. Its node_modules " +
        "will be Linux-specific after this run; rerun initialization before " +
        "using the same checkout from native Windows.",
    );
  }
  warnAboutWorkspaceHygiene();

  if (!checkOnly) {
    await offerClaudeLocalSettings(projectRoot);
    for (const install of buildDependencyInstallPlan(projectRoot)) {
      console.log(`\nInstalling ${install.label}...`);
      runNpm(install.args, {
        cwd: install.cwd,
        phase: `${install.label} installation`,
      });
    }
  }

  verifyInstalledEntrypoints();
  verifyOrRecoverProvenanceLedger(checkOnly);
  runVerification();
  console.log("\nPropel-ADW initialization completed successfully.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = tokenizeInitializerOutput(
      error instanceof Error ? error.message : String(error),
    );
    console.error(`\nInitialization failed: ${message}`);
    process.exitCode = 1;
  });
}
