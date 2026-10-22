import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyClaudeMirrors } from "../compatibility/verify-claude-mirrors.js";
import {
  ClaudeCompatibilityManifestSchema,
  NativeAdwBaselineManifestSchema,
  type ClaudeCompatibilityManifest,
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

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  return content.split(search).length - 1;
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
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "propel-adw-parity-"));
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

test("declared instruction substitutions exactly reproduce CLAUDE.md and identityClean passes", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.targetRoot, ".");
  const instruction = manifest.files.find(
    (file) => file.category === "instruction",
  );
  assert.ok(instruction, "instruction manifest entry is required");

  let transformed = normalizeLineEndings(
    await readFile(path.join(projectRoot, instruction.sourcePath), "utf8"),
  );
  for (const transformation of instruction.transformations) {
    const sourceText = normalizeLineEndings(transformation.sourceText);
    assert.equal(
      countOccurrences(transformed, sourceText),
      transformation.expectedOccurrences,
      `${transformation.kind} source occurrence drifted`,
    );
    transformed = transformed
      .split(sourceText)
      .join(normalizeLineEndings(transformation.targetText));
  }

  const mirror = normalizeLineEndings(
    await readFile(path.join(projectRoot, instruction.mirrorPath), "utf8"),
  );
  assert.equal(transformed, mirror);
  const result = await verifyClaudeMirrors({ projectRoot, identityClean: true });
  assert.equal(result.identityClean, true);
});

test("runtime active-plan registry is absent from immutable baseline", async () => {
  const baseline = NativeAdwBaselineManifestSchema.parse(
    JSON.parse(
      await readFile(
        path.join(projectRoot, ".claude/native-adw-baseline.json"),
        "utf8",
      ),
    ),
  );

  assert.equal(
    baseline.files.some((file) => file.path === ".agents/active-plans.json"),
    false,
  );
});

test("runtime active-plan mutation does not fail identity-clean verification", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    const activePlansPath = path.join(
      fixtureRoot,
      ".agents/active-plans.json",
    );
    await mkdir(path.dirname(activePlansPath), { recursive: true });
    await writeFile(
      activePlansPath,
      `${JSON.stringify({ [legacyIdentity]: { status: "active" } })}\n`,
      "utf8",
    );
    const firstResult = await verifyClaudeMirrors({
      projectRoot: fixtureRoot,
      identityClean: true,
    });

    await writeFile(
      activePlansPath,
      `${JSON.stringify({ [legacyIdentity]: { status: "completed" } })}\n`,
      "utf8",
    );
    const secondResult = await verifyClaudeMirrors({
      projectRoot: fixtureRoot,
      identityClean: true,
    });

    assert.equal(firstResult.valid, true);
    assert.equal(secondResult.valid, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("identity-clean ignores only the exact runtime registry under .agents", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    const ordinaryAgentsJsonPath = path.join(
      fixtureRoot,
      ".agents/ordinary-source.json",
    );
    await writeFile(ordinaryAgentsJsonPath, `${legacyIdentity}\n`, "utf8");

    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot, identityClean: true }),
      /Legacy identity occurrence: \.agents\/ordinary-source\.json/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("identity-clean skips nested generated dependency and build trees", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    for (const generatedPath of [
      "app/node_modules/dependency/package.txt",
      "app/.next/cache/generated.txt",
    ]) {
      const absolutePath = path.join(fixtureRoot, generatedPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${legacyIdentity}\n`, "utf8");
    }

    const result = await verifyClaudeMirrors({
      projectRoot: fixtureRoot,
      identityClean: true,
    });
    assert.equal(result.identityClean, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("identity-clean skips ignored legacy runtime-data roots", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    for (const runtimePath of [
      "logs/sessions/legacy.jsonl",
      "tools/codebase-graph/data/info_graph.json",
    ]) {
      const absolutePath = path.join(fixtureRoot, runtimePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${legacyIdentity}\n`, "utf8");
    }

    const result = await verifyClaudeMirrors({
      projectRoot: fixtureRoot,
      identityClean: true,
    });
    assert.equal(result.identityClean, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("approved text hashes accept equivalent CRLF checkouts", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const gitignorePath = path.join(fixtureRoot, ".gitignore");
    const gitignore = await readFile(gitignorePath, "utf8");
    await writeFile(
      gitignorePath,
      gitignore.replace(/\r?\n/g, "\r\n"),
      "utf8",
    );

    const result = await verifyClaudeMirrors({
      projectRoot: fixtureRoot,
      identityClean: true,
    });
    assert.equal(result.identityClean, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("identity-clean scans large files without building one giant string", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    const largeSourcePath = path.join(fixtureRoot, "large-source.txt");
    await writeFile(
      largeSourcePath,
      `${"a".repeat(64 * 1024 - 3)}${legacyIdentity}\n`,
      "utf8",
    );

    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot, identityClean: true }),
      /Legacy identity occurrence: large-source\.txt/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("verifier rejects future runtime-state baseline entries", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const baselinePath = path.join(
      fixtureRoot,
      ".claude/native-adw-baseline.json",
    );
    const baseline = NativeAdwBaselineManifestSchema.parse(
      JSON.parse(await readFile(baselinePath, "utf8")),
    );
    baseline.files.unshift({
      path: ".agents/active-plans.json",
      sha256: "0".repeat(64),
      byteLength: 0,
    });
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot }),
      /Runtime state cannot be an immutable baseline file: \.agents\/active-plans\.json/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("verifier rejects undeclared CLAUDE.md wording changes in copied fixtures", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const fixtureClaudePath = path.join(fixtureRoot, "CLAUDE.md");
    const originalClaude = await readFile(fixtureClaudePath, "utf8");
    await writeFile(fixtureClaudePath, `${originalClaude}\nundeclared drift\n`, "utf8");
    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot }),
      /Undeclared Claude mirror difference: CLAUDE\.md/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("immutable native source drift still fails identity-clean verification", async () => {
  const fixtureRoot = await createCompatibilityFixture();
  try {
    const legacyIdentity = ["thor", "bit"].join("");
    const baselinePath = path.join(
      fixtureRoot,
      ".codex/hooks/comment_guard.ts",
    );
    const originalBaseline = await readFile(baselinePath, "utf8");
    await writeFile(baselinePath, `${originalBaseline}\n${legacyIdentity}\n`, "utf8");
    await assert.rejects(
      verifyClaudeMirrors({ projectRoot: fixtureRoot, identityClean: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Unapproved baseline file change: \.codex\/hooks\/comment_guard\.ts/,
        );
        assert.match(
          error.message,
          /Legacy identity occurrence: \.codex\/hooks\/comment_guard\.ts/,
        );
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
