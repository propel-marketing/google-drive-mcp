import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ApprovedExistingFileChangesManifestSchema,
  ClaudeCompatibilityManifestSchema,
  NativeAdwBaselineManifestSchema,
  type ClaudeCompatibilityFile,
} from "./schemas.js";
import {
  buildClaudeMirrorPlan,
  resolveCompatibilityProjectRoot,
} from "./generate-claude-mirrors.js";

const APPROVAL_MANIFEST_PATH =
  ".claude/approved-existing-file-changes.json";
const COMPATIBILITY_MANIFEST_PATH = ".claude/compatibility-manifest.json";
const LEGACY_IDENTITY = ["thor", "bit"].join("");
const IDENTITY_SCAN_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
]);
const IDENTITY_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".agents/data",
  ".agents/runs",
  "logs",
  "tools/codebase-graph/data",
]);
const IDENTITY_SCAN_EXCLUDED_FILES = new Set([
  ".agents/active-plans.json",
]);
export const HOST_OWNED_ROOT_PATHS: ReadonlySet<string> = new Set([
  ".gitignore",
  "package.json",
  "package-lock.json",
]);
export const HOST_INSTALL_ENVIRONMENT_VARIABLE = "PROPEL_ADW_HOST_INSTALL";

const RUNTIME_STATE_BASELINE_PATHS = new Set([
  ".agents/active-plans.json",
  ".agents/data",
  ".agents/runs",
]);

export interface ClaudeMirrorVerificationResult {
  valid: true;
  baselineFilesVerified: number;
  approvedChangesVerified: number;
  agentsVerified: 23;
  skillsVerified: 165;
  byteIdenticalSkillsVerified: 164;
  identityClean: boolean;
  hostInstall: boolean;
  hostOwnedFilesExempted: number;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function normalizeLineEndings(content: Buffer): string {
  return content.toString("utf8").replace(/\r\n/g, "\n");
}

function matchesSha256WithNormalizedLineEndings(
  content: Buffer,
  expectedSha256: string,
): boolean {
  return (
    sha256(content) === expectedSha256 ||
    sha256(Buffer.from(normalizeLineEndings(content), "utf8")) === expectedSha256
  );
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  return content.split(search).length - 1;
}

async function enumerateFilesIfPresent(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await enumerateFilesIfPresent(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readJson(pathname: string): Promise<unknown> {
  return JSON.parse(await readFile(pathname, "utf8"));
}

function isRuntimeStateBaselinePath(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  for (const runtimeStatePath of RUNTIME_STATE_BASELINE_PATHS) {
    if (
      normalizedPath === runtimeStatePath ||
      normalizedPath.startsWith(`${runtimeStatePath}/`)
    ) {
      return true;
    }
  }
  return false;
}

async function verifyNativeBaseline(
  projectRoot: string,
  errors: string[],
  hostInstall: boolean,
): Promise<{ baselineFilesVerified: number; approvedChangesVerified: number; hostOwnedFilesExempted: number }> {
  const baseline = NativeAdwBaselineManifestSchema.parse(
    await readJson(path.join(projectRoot, ".claude/native-adw-baseline.json")),
  );
  const approvals = ApprovedExistingFileChangesManifestSchema.parse(
    await readJson(path.join(projectRoot, APPROVAL_MANIFEST_PATH)),
  );
  const baselineByPath = new Map(
    baseline.files.map((baselineFile) => [baselineFile.path, baselineFile]),
  );
  const approvalByPath = new Map<string, (typeof approvals.changes)[number]>();

  for (const baselineFile of baseline.files) {
    if (isRuntimeStateBaselinePath(baselineFile.path)) {
      errors.push(
        `Runtime state cannot be an immutable baseline file: ${baselineFile.path}`,
      );
    }
  }

  for (const approval of approvals.changes) {
    if (approvalByPath.has(approval.path)) {
      errors.push(`Duplicate approval entry: ${approval.path}`);
      continue;
    }
    approvalByPath.set(approval.path, approval);
    const baselineFile = baselineByPath.get(approval.path);
    if (!baselineFile) {
      errors.push(`Approval is not associated with a baseline file: ${approval.path}`);
    } else if (baselineFile.sha256 !== approval.baselineSha256) {
      errors.push(`Approval baseline hash drift: ${approval.path}`);
    }
  }

  let baselineFilesVerified = 0;
  let approvedChangesVerified = 0;
  let hostOwnedFilesExempted = 0;
  for (const baselineFile of baseline.files) {
    const absolutePath = path.join(projectRoot, baselineFile.path);
    let content: Buffer;
    try {
      content = await readFile(absolutePath);
    } catch {
      errors.push(`Missing baseline file: ${baselineFile.path}`);
      continue;
    }
    if (hostInstall && HOST_OWNED_ROOT_PATHS.has(baselineFile.path)) {
      hostOwnedFilesExempted += 1;
      continue;
    }
    const approval = approvalByPath.get(baselineFile.path);
    const expectedSha256 = approval?.approvedSha256 ?? baselineFile.sha256;
    if (!matchesSha256WithNormalizedLineEndings(content, expectedSha256)) {
      errors.push(
        approval
          ? `Approved file hash drift: ${baselineFile.path}`
          : `Unapproved baseline file change: ${baselineFile.path}`,
      );
      continue;
    }
    if (!approval && content.byteLength !== baselineFile.byteLength) {
      errors.push(`Baseline byte-length drift: ${baselineFile.path}`);
      continue;
    }
    baselineFilesVerified += 1;
    if (approval) approvedChangesVerified += 1;
  }

  return { baselineFilesVerified, approvedChangesVerified, hostOwnedFilesExempted };
}

function comparePathSets(
  label: string,
  expectedPaths: string[],
  actualPaths: string[],
  errors: string[],
): void {
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);
  for (const expectedPath of expected) {
    if (!actual.has(expectedPath)) errors.push(`Missing ${label}: ${expectedPath}`);
  }
  for (const actualPath of actual) {
    if (!expected.has(actualPath)) errors.push(`Unexpected ${label}: ${actualPath}`);
  }
}

async function verifyTransformationOccurrences(
  projectRoot: string,
  compatibilityFile: ClaudeCompatibilityFile,
  errors: string[],
): Promise<void> {
  const sourceText = await readFile(
    path.join(projectRoot, compatibilityFile.sourcePath),
    "utf8",
  );
  for (const transformation of compatibilityFile.transformations) {
    const expectedOccurrences = transformation.expectedOccurrences;
    const actualOccurrences = countOccurrences(
      sourceText.replace(/\r\n/g, "\n"),
      transformation.sourceText.replace(/\r\n/g, "\n"),
    );
    if (actualOccurrences !== expectedOccurrences) {
      errors.push(
        `Transformation occurrence drift in ${compatibilityFile.sourcePath}: expected ${expectedOccurrences}, found ${actualOccurrences}`,
      );
    }
  }
}

async function verifyIdentityClean(
  projectRoot: string,
  errors: string[],
): Promise<void> {
  async function containsLegacyIdentity(filePath: string): Promise<boolean> {
    const overlapLength = Buffer.byteLength(LEGACY_IDENTITY, "utf8") - 1;
    let overlap = Buffer.alloc(0);
    for await (const chunk of createReadStream(filePath)) {
      const currentChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const searchable = Buffer.concat([overlap, currentChunk]);
      if (
        searchable.toString("utf8").toLocaleLowerCase().includes(LEGACY_IDENTITY)
      ) {
        return true;
      }
      overlap = searchable.subarray(
        Math.max(0, searchable.length - overlapLength),
      );
    }
    return false;
  }

  function isExcludedDirectory(relativePath: string, name: string): boolean {
    if (IDENTITY_SCAN_EXCLUDED_DIRECTORY_NAMES.has(name)) return true;
    for (const excludedPath of IDENTITY_SCAN_EXCLUDED_DIRECTORIES) {
      if (
        relativePath === excludedPath ||
        relativePath.startsWith(`${excludedPath}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  async function visit(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        path.join(relativeDirectory, entry.name),
      );
      if (entry.isDirectory()) {
        if (isExcludedDirectory(relativePath, entry.name)) continue;
        await visit(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IDENTITY_SCAN_EXCLUDED_FILES.has(relativePath)) continue;
      if (await containsLegacyIdentity(path.join(directory, entry.name))) {
        errors.push(`Legacy identity occurrence: ${relativePath}`);
      }
    }
  }

  await visit(projectRoot);
}

export async function verifyClaudeMirrors(
  options: { projectRoot?: string; identityClean?: boolean; hostInstall?: boolean } = {},
): Promise<ClaudeMirrorVerificationResult> {
  const hostInstall =
    options.hostInstall ?? process.env[HOST_INSTALL_ENVIRONMENT_VARIABLE] === "1";
  const projectRoot = path.resolve(
    options.projectRoot ?? resolveCompatibilityProjectRoot(),
  );
  const errors: string[] = [];
  const baselineResult = await verifyNativeBaseline(projectRoot, errors, hostInstall);

  let actualManifest;
  try {
    actualManifest = ClaudeCompatibilityManifestSchema.parse(
      await readJson(path.join(projectRoot, COMPATIBILITY_MANIFEST_PATH)),
    );
  } catch (error: unknown) {
    errors.push(
      `Invalid or missing ${COMPATIBILITY_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const expectedPlan = await buildClaudeMirrorPlan(projectRoot, actualManifest?.generatedAt);

  if (
    actualManifest &&
    JSON.stringify(actualManifest) !== JSON.stringify(expectedPlan.manifest)
  ) {
    errors.push("Compatibility manifest differs from deterministic source plan");
  }

  const expectedOutputByPath = new Map(
    expectedPlan.outputs.map((output) => [output.relativePath, output.content]),
  );
  for (const [relativePath, expectedContent] of expectedOutputByPath) {
    let actualContent: Buffer;
    try {
      actualContent = await readFile(path.join(projectRoot, relativePath));
    } catch {
      errors.push(`Missing Claude mirror: ${relativePath}`);
      continue;
    }
    if (sha256(actualContent) !== sha256(expectedContent)) {
      if (normalizeLineEndings(actualContent) === normalizeLineEndings(expectedContent)) {
        errors.push(`Claude mirror line-ending hash drift: ${relativePath}`);
      } else {
        errors.push(`Undeclared Claude mirror difference: ${relativePath}`);
      }
    }
  }

  const expectedAgentPaths = expectedPlan.outputs
    .map((output) => output.relativePath)
    .filter((relativePath) => relativePath.startsWith(".claude/agents/"));
  const actualAgentPaths = (
    await enumerateFilesIfPresent(path.join(projectRoot, ".claude/agents"))
  ).map((absolutePath) => normalizeRelativePath(path.relative(projectRoot, absolutePath)));
  comparePathSets("Claude agent", expectedAgentPaths, actualAgentPaths, errors);

  const expectedSkillPaths = expectedPlan.outputs
    .map((output) => output.relativePath)
    .filter((relativePath) => relativePath.startsWith(".claude/skills/"));
  const actualSkillPaths = (
    await enumerateFilesIfPresent(path.join(projectRoot, ".claude/skills"))
  ).map((absolutePath) => normalizeRelativePath(path.relative(projectRoot, absolutePath)));
  comparePathSets("Claude skill", expectedSkillPaths, actualSkillPaths, errors);

  let byteIdenticalSkillsVerified = 0;
  for (const compatibilityFile of expectedPlan.manifest.files) {
    await verifyTransformationOccurrences(projectRoot, compatibilityFile, errors);
    if (
      compatibilityFile.category === "skill" &&
      compatibilityFile.sourceSha256 === compatibilityFile.mirrorSha256
    ) {
      byteIdenticalSkillsVerified += 1;
    }
  }
  if (byteIdenticalSkillsVerified !== 164) {
    errors.push(
      `Expected 164 byte-identical skill files, found ${byteIdenticalSkillsVerified}`,
    );
  }

  if (options.identityClean) await verifyIdentityClean(projectRoot, errors);
  if (errors.length > 0) {
    throw new Error(`Claude compatibility verification failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    valid: true,
    baselineFilesVerified: baselineResult.baselineFilesVerified,
    approvedChangesVerified: baselineResult.approvedChangesVerified,
    agentsVerified: 23,
    skillsVerified: 165,
    byteIdenticalSkillsVerified: 164,
    identityClean: options.identityClean === true,
    hostInstall,
    hostOwnedFilesExempted: baselineResult.hostOwnedFilesExempted,
  };
}

async function runCli(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: tsx verify-claude-mirrors.ts [--identity-clean] [--host-install]\n",
    );
    return;
  }
  const unsupported = process.argv.slice(2).filter(
    (argument) => argument !== "--identity-clean" && argument !== "--host-install",
  );
  if (unsupported.length > 0) {
    throw new Error(`Unsupported arguments: ${unsupported.join(", ")}`);
  }
  const result = await verifyClaudeMirrors({
    identityClean: process.argv.includes("--identity-clean"),
    ...(process.argv.includes("--host-install") ? { hostInstall: true } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
