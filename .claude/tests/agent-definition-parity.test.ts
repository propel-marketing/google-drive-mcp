import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ClaudeCompatibilityManifestSchema,
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
const supportedFrontmatterFields = new Set([
  "name",
  "description",
  "model",
  "effort",
]);

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  return content.split(search).length - 1;
}

function parseAgentMarkdown(content: string): {
  fields: Map<string, string>;
  body: string;
} {
  const normalized = normalizeLineEndings(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  assert.ok(match, "Claude agent must start with YAML frontmatter");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return { fields, body: normalized.slice(match[0].length) };
}

function readTomlString(source: string, key: string): string {
  const match = source.match(
    new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, "m"),
  );
  assert.ok(match, `${key} missing from Codex agent`);
  return JSON.parse(match[1]) as string;
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

test("all 23 agents use supported frontmatter with inherit model and exact effort", async () => {
  const manifest = await loadManifest();
  const agentRecords = manifest.files.filter((file) => file.category === "agent");
  assert.equal(agentRecords.length, 23);

  const agentFilenames = (await readdir(path.join(projectRoot, ".claude/agents")))
    .filter((filename) => filename.endsWith(".md"))
    .sort();
  assert.equal(agentFilenames.length, 23);
  assert.deepEqual(
    agentFilenames,
    agentRecords
      .map((record) => path.posix.basename(record.mirrorPath))
      .sort(),
  );

  for (const record of agentRecords) {
    const source = await readFile(path.join(projectRoot, record.sourcePath), "utf8");
    const mirror = await readFile(path.join(projectRoot, record.mirrorPath), "utf8");
    const { fields } = parseAgentMarkdown(mirror);

    assert.deepEqual(new Set(fields.keys()), supportedFrontmatterFields);
    assert.equal(JSON.parse(fields.get("name") ?? "null"), readTomlString(source, "name"));
    assert.equal(
      JSON.parse(fields.get("description") ?? "null"),
      readTomlString(source, "description"),
    );
    assert.equal(fields.get("model"), "inherit");
    assert.equal(fields.get("effort"), readTomlString(source, "model_reasoning_effort"));
    assert.equal(fields.has("nickname_candidates"), false);
    assert.equal(fields.has("skills"), false);
    assert.equal(fields.has("tools"), false);
  }
});

test("agent bodies match the deterministic plan and keep default Agent capability", async () => {
  const manifest = await loadManifest();
  const agentRecords = manifest.files.filter((file) => file.category === "agent");
  assert.equal(agentRecords.length, 23);

  let orchestrationCapableAgents = 0;
  for (const record of agentRecords) {
    const sourceContent = normalizeLineEndings(
      await readFile(path.join(projectRoot, record.sourcePath), "utf8"),
    );
    const [frontmatterConversion, ...bodyTransformations] =
      record.transformations;
    assert.equal(frontmatterConversion?.kind, "frontmatter-conversion");
    assert.equal(
      normalizeLineEndings(frontmatterConversion.sourceText),
      sourceContent,
    );
    let declaredMirror = normalizeLineEndings(frontmatterConversion.targetText);
    for (const transformation of bodyTransformations) {
      const sourceText = normalizeLineEndings(transformation.sourceText);
      assert.equal(
        countOccurrences(declaredMirror, sourceText),
        transformation.expectedOccurrences,
      );
      declaredMirror = declaredMirror
        .split(sourceText)
        .join(normalizeLineEndings(transformation.targetText));
    }

    const actualContent = await readFile(
      path.join(projectRoot, record.mirrorPath),
      "utf8",
    );
    assert.equal(normalizeLineEndings(actualContent), declaredMirror);
    const { fields, body } = parseAgentMarkdown(actualContent);
    assert.ok(body.length > 0, `${record.mirrorPath} has an empty body`);

    if (/subagent|orchestrat|spawn/iu.test(body)) {
      orchestrationCapableAgents += 1;
      assert.equal(
        fields.has("tools"),
        false,
        "omitting a tools allowlist retains Claude's default Agent tool capability",
      );
    }
  }
  assert.ok(orchestrationCapableAgents > 0);
});
