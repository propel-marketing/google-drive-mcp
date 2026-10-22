import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HOST_OWNED_ROOT_PATHS,
  verifyClaudeMirrors,
} from "../compatibility/verify-claude-mirrors.js";
import {
  ClaudeCompatibilityManifestSchema,
  NativeAdwBaselineManifestSchema,
} from "../compatibility/schemas.js";

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

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

async function createHostFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "propel-adw-host-install-"));
  const baseline = NativeAdwBaselineManifestSchema.parse(
    await readJson(".claude/native-adw-baseline.json"),
  );
  const manifest = ClaudeCompatibilityManifestSchema.parse(
    await readJson(".claude/compatibility-manifest.json"),
  );
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
  for (const hostOwnedPath of HOST_OWNED_ROOT_PATHS) {
    await appendFile(path.join(fixtureRoot, hostOwnedPath), "\nhost-project-content\n");
  }
  return fixtureRoot;
}

test("host-owned root paths are exactly the host project's package manifests and .gitignore", () => {
  assert.deepEqual(
    [...HOST_OWNED_ROOT_PATHS].sort(),
    [".gitignore", "package-lock.json", "package.json"],
  );
});

test("strict verification still rejects host-changed root files", async (t) => {
  const fixtureRoot = await createHostFixture();
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await assert.rejects(
    verifyClaudeMirrors({ projectRoot: fixtureRoot, hostInstall: false }),
    /(?:Approved file hash drift|Unapproved baseline file change): package\.json/,
  );
});

test("host-install verification exempts only the host-owned root files", async (t) => {
  const fixtureRoot = await createHostFixture();
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const result = await verifyClaudeMirrors({ projectRoot: fixtureRoot, hostInstall: true });
  assert.equal(result.hostInstall, true);
  assert.equal(result.hostOwnedFilesExempted, HOST_OWNED_ROOT_PATHS.size);
});

test("host-install verification still rejects changes to ADW-owned baseline files", async (t) => {
  const fixtureRoot = await createHostFixture();
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await appendFile(path.join(fixtureRoot, "AGENTS.md"), "\nhost-edit\n");
  await assert.rejects(
    verifyClaudeMirrors({ projectRoot: fixtureRoot, hostInstall: true }),
    /(?:Approved file hash drift|Unapproved baseline file change): AGENTS\.md/,
  );
});

test("host-install verification still requires the host-owned root files to exist", async (t) => {
  const fixtureRoot = await createHostFixture();
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await rm(path.join(fixtureRoot, "package.json"));
  await assert.rejects(
    verifyClaudeMirrors({ projectRoot: fixtureRoot, hostInstall: true }),
    /Missing baseline file: package\.json/,
  );
});
