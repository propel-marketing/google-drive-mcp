/// <reference types="node" />

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ClaudeCompatibilityManifestSchema,
  type ClaudeCompatibilityFile,
  type ClaudeCompatibilityManifest,
  type ClaudeCompatibilityTransformation,
} from "./schemas.js";

const EXPECTED_AGENT_COUNT = 23;
const EXPECTED_SKILL_COUNT = 165;
const TASK_ORCHESTRATION_SKILL =
  ".agents/skills/task-orchestration/SKILL.md";

const INSTRUCTION_TRANSFORMATIONS: ReadonlyArray<
  Omit<ClaudeCompatibilityTransformation, "expectedOccurrences">
> = [
  {
    kind: "tool-lifecycle-substitution",
    sourceText:
      "- After `wait_agent` returns, the parent must read the final response, consume the named output, verify persisted task/report state, then call `close_agent` for that child before advancing.",
    targetText:
      "- After the `Agent` result returns, the parent must read the final response, consume the named output, and verify persisted task/report state before advancing; Claude Code automatically releases completed subagents.",
    reason: "Map the Codex child-result and close lifecycle to Claude Code.",
  },
  {
    kind: "tool-lifecycle-substitution",
    sourceText:
      "- If a child times out or omits `ORCHESTRATOR_SIGNAL`, inspect task state and output files, send at most one corrective message if recovery is likely, otherwise close the child and respawn a replacement. Do not leave idle completed agents open.",
    targetText:
      "- If a child times out or omits `ORCHESTRATOR_SIGNAL`, inspect task state and output files, send at most one corrective `Agent` request if recovery is likely, otherwise start a replacement. Claude Code automatically releases completed subagents.",
    reason: "Express timeout recovery using Claude Code's Agent lifecycle.",
  },
];

const TASK_ORCHESTRATION_TRANSFORMATIONS: ReadonlyArray<
  Omit<ClaudeCompatibilityTransformation, "expectedOccurrences">
> = [
  {
    kind: "tool-lifecycle-substitution",
    sourceText: "**Parent responsibility:** after every `wait_agent` result:",
    targetText: "**Parent responsibility:** after every `Agent` result:",
    reason: "Consume Claude Code Agent results directly.",
  },
  {
    kind: "tool-lifecycle-substitution",
    sourceText:
      "3. If the child has no immediate follow-up question, call `close_agent` on that child agent. Do this for PASS, FAIL, BLOCKED, and ISSUES_FOUND outcomes after the result has been captured.",
    targetText:
      "3. If the child has no immediate follow-up question, retain the captured result; Claude Code automatically releases completed subagents after PASS, FAIL, BLOCKED, and ISSUES_FOUND outcomes.",
    reason: "Use Claude Code's automatic completed-subagent lifecycle.",
  },
  {
    kind: "tool-lifecycle-substitution",
    sourceText:
      "4. If a child times out or does not emit `ORCHESTRATOR_SIGNAL`, inspect task state and output files, then either send one corrective message or close the child and respawn a replacement. Do not leave idle completed agents open.",
    targetText:
      "4. If a child times out or does not emit `ORCHESTRATOR_SIGNAL`, inspect task state and output files, then either send one corrective `Agent` request or start a replacement. Claude Code automatically releases completed subagents.",
    reason: "Map timeout recovery to Claude Code Agent calls.",
  },
  {
    kind: "tool-lifecycle-substitution",
    sourceText:
      "5. Continue the orchestration loop immediately after all completed children in the current wave are consumed and closed.",
    targetText:
      "5. Continue the orchestration loop immediately after all completed children in the current wave are consumed.",
    reason: "Remove the unavailable explicit child-close step.",
  },
];

const HARNESS_PATH_TRANSFORMATIONS: ReadonlyArray<
  Omit<ClaudeCompatibilityTransformation, "expectedOccurrences">
> = [
  {
    kind: "harness-path-substitution",
    sourceText: ".codex/agents",
    targetText: ".claude/agents",
    reason: "Use Claude Code's project agent discovery directory.",
  },
  {
    kind: "harness-path-substitution",
    sourceText: ".codex/config.toml",
    targetText: ".claude/settings.json",
    reason: "Use Claude Code's project settings file.",
  },
  {
    kind: "harness-path-substitution",
    sourceText: ".codex/hooks",
    targetText: ".claude/hooks",
    reason: "Use the Claude Code-local hook bridge directory.",
  },
];

export interface ClaudeMirrorOutput {
  relativePath: string;
  content: Buffer;
}

export interface ClaudeMirrorPlan {
  manifest: ClaudeCompatibilityManifest;
  outputs: ClaudeMirrorOutput[];
}

interface ParsedCodexAgent {
  name: string;
  description: string;
  effort: string;
  developerInstructions: string;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  return content.split(search).length - 1;
}

function applyDeclaredTransformations(
  source: string,
  declarations: ReadonlyArray<
    Omit<ClaudeCompatibilityTransformation, "expectedOccurrences">
  >,
  required: boolean,
): { content: string; transformations: ClaudeCompatibilityTransformation[] } {
  let content = source;
  const transformations: ClaudeCompatibilityTransformation[] = [];

  for (const declaration of declarations) {
    const expectedOccurrences = countOccurrences(content, declaration.sourceText);
    if (required && expectedOccurrences !== 1) {
      throw new Error(
        `Expected exactly one occurrence of declared transformation source: ${declaration.sourceText}`,
      );
    }
    if (expectedOccurrences === 0) continue;

    transformations.push({ ...declaration, expectedOccurrences });
    content = content.split(declaration.sourceText).join(declaration.targetText);
  }

  return { content, transformations };
}

function applyHarnessTransformations(source: string): {
  content: string;
  transformations: ClaudeCompatibilityTransformation[];
} {
  const pathResult = applyDeclaredTransformations(
    source,
    HARNESS_PATH_TRANSFORMATIONS,
    false,
  );
  const harnessName: Omit<
    ClaudeCompatibilityTransformation,
    "expectedOccurrences"
  > = {
    kind: "harness-name-substitution",
    sourceText: "Codex",
    targetText: "Claude Code",
    reason: "Identify the active project harness as Claude Code.",
  };
  const nameResult = applyDeclaredTransformations(
    pathResult.content,
    [harnessName],
    false,
  );
  return {
    content: nameResult.content,
    transformations: [
      ...pathResult.transformations,
      ...nameResult.transformations,
    ],
  };
}

function readBasicTomlString(source: string, key: string): string | undefined {
  const match = source.match(
    new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, "m"),
  );
  if (!match) return undefined;
  return JSON.parse(match[1]) as string;
}

function readDeveloperInstructions(source: string): string {
  const assignment = source.match(/^developer_instructions\s*=\s*/m);
  if (!assignment || assignment.index === undefined) {
    throw new Error("Agent TOML is missing developer_instructions");
  }

  const valueStart = assignment.index + assignment[0].length;
  if (source.startsWith('"""', valueStart)) {
    const bodyStart = valueStart + 3;
    const bodyEnd = source.indexOf('"""', bodyStart);
    if (bodyEnd < 0) throw new Error("Unterminated TOML multiline string");
    return source.slice(bodyStart, bodyEnd);
  }

  if (source[valueStart] !== '"') {
    throw new Error("Unsupported developer_instructions TOML value");
  }
  let escaped = false;
  for (let index = valueStart + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return JSON.parse(source.slice(valueStart, index + 1)) as string;
    }
  }
  throw new Error("Unterminated developer_instructions TOML string");
}

function parseCodexAgent(source: string, sourcePath: string): ParsedCodexAgent {
  const name = readBasicTomlString(source, "name");
  const description = readBasicTomlString(source, "description");
  const effort = readBasicTomlString(source, "model_reasoning_effort");
  if (!name || !description || !effort) {
    throw new Error(`Unsupported or incomplete agent metadata in ${sourcePath}`);
  }
  return {
    name,
    description,
    effort,
    developerInstructions: readDeveloperInstructions(source),
  };
}

function renderAgentMarkdown(agent: ParsedCodexAgent): string {
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description)}`,
    "model: inherit",
    `effort: ${agent.effort}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${agent.developerInstructions.replace(/\r\n/g, "\n")}`;
}

async function enumerateFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await enumerateFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function createFileRecord(
  category: ClaudeCompatibilityFile["category"],
  sourcePath: string,
  mirrorPath: string,
  sourceContent: Buffer,
  mirrorContent: Buffer,
  generationMode: ClaudeCompatibilityFile["generationMode"],
  transformations: ClaudeCompatibilityTransformation[],
): ClaudeCompatibilityFile {
  return {
    category,
    sourcePath,
    mirrorPath,
    sourceSha256: sha256(sourceContent),
    mirrorSha256: sha256(mirrorContent),
    sourceByteLength: sourceContent.byteLength,
    mirrorByteLength: mirrorContent.byteLength,
    generationMode,
    transformations,
  };
}

export function resolveCompatibilityProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function buildClaudeMirrorPlan(
  projectRoot = resolveCompatibilityProjectRoot(),
  generatedAt = new Date().toISOString(),
): Promise<ClaudeMirrorPlan> {
  const outputs: ClaudeMirrorOutput[] = [];
  const files: ClaudeCompatibilityFile[] = [];

  const agentsPath = path.join(projectRoot, ".codex", "agents");
  const agentSourcePaths = (await enumerateFiles(agentsPath)).filter(
    (sourcePath) => path.extname(sourcePath) === ".toml",
  );
  if (agentSourcePaths.length !== EXPECTED_AGENT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_AGENT_COUNT} Codex agents, found ${agentSourcePaths.length}`,
    );
  }

  const instructionSourcePath = "AGENTS.md";
  const instructionMirrorPath = "CLAUDE.md";
  const instructionSource = await readFile(
    path.join(projectRoot, instructionSourcePath),
  );
  const instructionText = instructionSource.toString("utf8").replace(/\r\n/g, "\n");
  const instructionLifecycle = applyDeclaredTransformations(
    instructionText,
    INSTRUCTION_TRANSFORMATIONS,
    true,
  );
  const instructionHarness = applyHarnessTransformations(
    instructionLifecycle.content,
  );
  const instructionMirror = Buffer.from(instructionHarness.content, "utf8");
  outputs.push({ relativePath: instructionMirrorPath, content: instructionMirror });
  files.push(
    createFileRecord(
      "instruction",
      instructionSourcePath,
      instructionMirrorPath,
      instructionSource,
      instructionMirror,
      "transformed-copy",
      [
        ...instructionLifecycle.transformations,
        ...instructionHarness.transformations,
      ],
    ),
  );

  for (const absoluteSourcePath of agentSourcePaths) {
    const sourcePath = normalizeRelativePath(
      path.relative(projectRoot, absoluteSourcePath),
    );
    const sourceContent = await readFile(absoluteSourcePath);
    const sourceText = sourceContent.toString("utf8");
    const parsedAgent = parseCodexAgent(sourceText, sourcePath);
    const initialMarkdown = renderAgentMarkdown(parsedAgent);
    const harnessResult = applyHarnessTransformations(initialMarkdown);
    const mirrorContent = Buffer.from(harnessResult.content, "utf8");
    const mirrorPath = `.claude/agents/${parsedAgent.name}.md`;
    const frontmatterTransformation: ClaudeCompatibilityTransformation = {
      kind: "frontmatter-conversion",
      sourceText,
      targetText: initialMarkdown,
      reason:
        "Convert supported Codex TOML metadata to Claude YAML frontmatter, omit unsupported metadata, and preserve developer_instructions as the body.",
      expectedOccurrences: 1,
    };
    outputs.push({ relativePath: mirrorPath, content: mirrorContent });
    files.push(
      createFileRecord(
        "agent",
        sourcePath,
        mirrorPath,
        sourceContent,
        mirrorContent,
        "agent-frontmatter",
        [frontmatterTransformation, ...harnessResult.transformations],
      ),
    );
  }

  const skillsRoot = path.join(projectRoot, ".agents", "skills");
  const skillSourcePaths = await enumerateFiles(skillsRoot);
  if (skillSourcePaths.length !== EXPECTED_SKILL_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_SKILL_COUNT} skill files, found ${skillSourcePaths.length}`,
    );
  }

  for (const absoluteSourcePath of skillSourcePaths) {
    const sourcePath = normalizeRelativePath(
      path.relative(projectRoot, absoluteSourcePath),
    );
    const mirrorPath = sourcePath.replace(/^\.agents\/skills\//, ".claude/skills/");
    const sourceContent = await readFile(absoluteSourcePath);
    let mirrorContent = sourceContent;
    let transformations: ClaudeCompatibilityTransformation[] = [];
    let generationMode: ClaudeCompatibilityFile["generationMode"] = "byte-copy";

    if (sourcePath === TASK_ORCHESTRATION_SKILL) {
      const sourceText = sourceContent.toString("utf8").replace(/\r\n/g, "\n");
      const lifecycleResult = applyDeclaredTransformations(
        sourceText,
        TASK_ORCHESTRATION_TRANSFORMATIONS,
        true,
      );
      mirrorContent = Buffer.from(lifecycleResult.content, "utf8");
      transformations = lifecycleResult.transformations;
      generationMode = "transformed-copy";
    } else {
      transformations = [
        {
          kind: "byte-copy",
          sourceText: "",
          targetText: "",
          reason: "Preserve the native ADW skill file byte-for-byte.",
          expectedOccurrences: 0,
        },
      ];
    }

    outputs.push({ relativePath: mirrorPath, content: mirrorContent });
    files.push(
      createFileRecord(
        "skill",
        sourcePath,
        mirrorPath,
        sourceContent,
        mirrorContent,
        generationMode,
        transformations,
      ),
    );
  }

  files.sort((left, right) => left.mirrorPath.localeCompare(right.mirrorPath));
  outputs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest = ClaudeCompatibilityManifestSchema.parse({
    schemaVersion: 1,
    generatedAt,
    sourceRoot: ".",
    targetRoot: ".",
    files,
    counts: {
      instructions: 1,
      agents: EXPECTED_AGENT_COUNT,
      skills: EXPECTED_SKILL_COUNT,
      byteIdenticalSkills: EXPECTED_SKILL_COUNT - 1,
    },
  });
  return { manifest, outputs };
}

export async function generateClaudeMirrors(
  projectRoot = resolveCompatibilityProjectRoot(),
): Promise<ClaudeCompatibilityManifest> {
  const plan = await buildClaudeMirrorPlan(projectRoot);
  for (const output of plan.outputs) {
    const absoluteOutputPath = path.join(projectRoot, output.relativePath);
    await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, output.content);
  }

  const manifestPath = path.join(
    projectRoot,
    ".claude",
    "compatibility-manifest.json",
  );
  await writeFile(manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
  return plan.manifest;
}

async function runCli(): Promise<void> {
  const manifest = await generateClaudeMirrors();
  process.stdout.write(
    `Generated CLAUDE.md, ${manifest.counts.agents} .claude/agents files, and ${manifest.counts.skills} .claude/skills files.\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Claude mirror generation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
