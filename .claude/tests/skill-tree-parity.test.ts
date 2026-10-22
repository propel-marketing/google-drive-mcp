import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ClaudeCompatibilityManifestSchema,
  NativeAdwBaselineManifestSchema,
  type ClaudeCompatibilityManifest,
} from "../compatibility/schemas.js";
import { verifyClaudeMirrors } from "../compatibility/verify-claude-mirrors.js";

function resolveProjectRoot(startDirectory = process.cwd()): string {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, ".claude/compatibility-manifest.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not resolve project root");
    current = parent;
  }
}

const projectRoot = resolveProjectRoot();
const taskOrchestrationPath = "task-orchestration/SKILL.md";

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

async function enumerateRelativeFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await enumerateRelativeFiles(root, absolutePath)));
    else if (entry.isFile()) files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
  }
  return files.sort();
}

async function loadManifest(): Promise<ClaudeCompatibilityManifest> {
  return ClaudeCompatibilityManifestSchema.parse(
    JSON.parse(
      await readFile(
        path.join(projectRoot, ".claude/compatibility-manifest.json"),
        "utf8",
      ),
    ),
  );
}

async function createCompatibilityFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "propel-adw-skills-"));
  const baseline = NativeAdwBaselineManifestSchema.parse(
    JSON.parse(
      await readFile(
        path.join(projectRoot, ".claude/native-adw-baseline.json"),
        "utf8",
      ),
    ),
  );
  const manifest = await loadManifest();
  const fixturePaths = new Set([
    ...baseline.files.map((file) => file.path),
    ...manifest.files.map((file) => file.sourcePath),
    ...manifest.files.map((file) => file.mirrorPath),
    ".claude/native-adw-baseline.json",
    ".claude/approved-existing-file-changes.json",
    ".claude/compatibility-manifest.json",
  ]);
  for (const relativePath of fixturePaths) {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(projectRoot, relativePath), destination);
  }
  return fixtureRoot;
}

test("165 mirrored skills include 164 byte-identical files and one declared lifecycle transform", async () => {
  const sourceRoot = path.join(projectRoot, ".agents/skills");
  const mirrorRoot = path.join(projectRoot, ".claude/skills");
  const sourcePaths = await enumerateRelativeFiles(sourceRoot);
  const mirrorPaths = await enumerateRelativeFiles(mirrorRoot);
  assert.equal(sourcePaths.length, 165);
  assert.equal(mirrorPaths.length, 165);
  assert.deepEqual(mirrorPaths, sourcePaths);

  let byteIdentical = 0;
  for (const relativePath of sourcePaths) {
    const source = await readFile(path.join(sourceRoot, relativePath));
    const mirror = await readFile(path.join(mirrorRoot, relativePath));
    if (source.equals(mirror)) byteIdentical += 1;
  }
  assert.equal(byteIdentical, 164);

  const manifest = await loadManifest();
  const skillRecords = manifest.files.filter((file) => file.category === "skill");
  assert.equal(skillRecords.length, 165);
  const taskRecord = skillRecords.find((file) =>
    file.mirrorPath.endsWith(taskOrchestrationPath),
  );
  assert.ok(taskRecord);
  assert.equal(taskRecord.generationMode, "transformed-copy");
  assert.ok(taskRecord.transformations.length > 0);
  assert.ok(
    taskRecord.transformations.every(
      (transformation) =>
        transformation.kind === "tool-lifecycle-substitution" &&
        transformation.expectedOccurrences === 1,
    ),
  );

  let transformed = normalizeLineEndings(
    await readFile(path.join(projectRoot, taskRecord.sourcePath), "utf8"),
  );
  for (const transformation of taskRecord.transformations) {
    transformed = transformed
      .split(normalizeLineEndings(transformation.sourceText))
      .join(normalizeLineEndings(transformation.targetText));
  }
  assert.equal(
    transformed,
    normalizeLineEndings(
      await readFile(path.join(projectRoot, taskRecord.mirrorPath), "utf8"),
    ),
  );
});

test("verifier rejects missing, extra, and tampered skill files in copied fixtures", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  const mirrorRoot = path.join(fixtureRoot, ".claude/skills");
  const missingPath = path.join(mirrorRoot, "workflow/agents/openai.yaml");
  const originalMissingContent = await readFile(missingPath);
  try {
    await unlink(missingPath);
    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot }),
      /Missing Claude (?:mirror|skill): \.claude\/skills\/workflow\/agents\/openai\.yaml/,
    );

    await mkdir(path.dirname(missingPath), { recursive: true });
    await writeFile(missingPath, originalMissingContent);
    const extraPath = path.join(mirrorRoot, "unexpected.md");
    await writeFile(extraPath, "unexpected\n", "utf8");
    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot }),
      /Unexpected Claude skill: \.claude\/skills\/unexpected\.md/,
    );
    await unlink(extraPath);

    const taskMirrorPath = path.join(mirrorRoot, taskOrchestrationPath);
    const originalTaskMirror = await readFile(taskMirrorPath, "utf8");
    await writeFile(taskMirrorPath, `${originalTaskMirror}\ntampered\n`, "utf8");
    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot }),
      /Undeclared Claude mirror difference: \.claude\/skills\/task-orchestration\/SKILL\.md/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
