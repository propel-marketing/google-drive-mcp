import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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

async function readProjectFile(relativePath: string): Promise<string> {
  return (await readFile(path.join(projectRoot, relativePath), "utf8")).replace(
    /\r\n/gu,
    "\n",
  );
}

for (const commandName of ["prime", "log-session"] as const) {
  test(`${commandName} uses the exact native name and identical harness instructions`, async () => {
    const codexSkillPath = `.agents/skills/${commandName}/SKILL.md`;
    const claudeCommandPath = `.claude/commands/${commandName}.md`;
    const claudeSkillPath = `.claude/skills/${commandName}/SKILL.md`;
    const codexSkill = await readProjectFile(codexSkillPath);
    const claudeCommand = await readProjectFile(claudeCommandPath);
    const claudeSkill = await readProjectFile(claudeSkillPath);

    assert.equal(claudeCommand, codexSkill);
    assert.equal(claudeSkill, codexSkill);
    assert.match(codexSkill, new RegExp(`^---\\nname: ${commandName}\\n`, "u"));
    assert.doesNotMatch(codexSkill, /source-command-/u);
  });
}

test("prime loads bounded current context without project-specific assumptions", async () => {
  const prime = await readProjectFile(".agents/skills/prime/SKILL.md");
  for (const requiredText of [
    "README.md",
    "app/README.md",
    "Git remote repository name",
    "Memory Bank",
    ".agents/active-plans.json",
    ".agents/scripts/tasks.ts",
    "work-tracking/README.md",
    "work-tracking/committed.md",
    "work-tracking/bugs.md",
    "work-tracking/proposed.md",
    "docs/migration/",
  ]) {
    assert.ok(prime.includes(requiredText), `prime is missing ${requiredText}`);
  }
  assert.match(prime, /This skill is read-only/u);
  assert.match(prime, /Do not inventory the entire repository/u);
  assert.match(prime, /Do not read raw transcripts or raw provenance JSONL/u);
  assert.match(prime, /Do not create a new Memory Bank project/u);
  assert.doesNotMatch(prime, /project `Spark`/u);
  assert.doesNotMatch(prime, /spark-application-context/u);
});

test("log-session restores the session and documentation workflow", async () => {
  const logSession = await readProjectFile(
    ".agents/skills/log-session/SKILL.md",
  );
  for (const requiredHeading of [
    "### Step 1: Parse the Argument",
    "### Step 2: Identify the Current Session",
    "### Step 3: Gather Session Context",
    "### Step 4: Generate the Session Entry",
    "### Step 5: Write the File",
    "### Step 6: Confirm",
    "### Step 7: README Update Checks",
    "### Step 8: Work-Tracking Update Check",
  ]) {
    assert.ok(
      logSession.includes(requiredHeading),
      `log-session is missing ${requiredHeading}`,
    );
  }
  assert.match(logSession, /\.claude\/session-progress\.md/u);
  assert.match(logSession, /Root README \(`README\.md`\)/u);
  assert.match(logSession, /App README \(`app\/README\.md`\)/u);
});

test("log-session resolves Codex thread IDs before legacy provenance fallback", async () => {
  const logSession = await readProjectFile(
    ".agents/skills/log-session/SKILL.md",
  );
  const environmentIndex = logSession.indexOf(
    "Use the non-empty `CODEX_THREAD_ID` value.",
  );
  const legacyIndex = logSession.indexOf(
    "Otherwise, use `SessionStart.session_id` from the selected legacy JSONL file.",
  );
  const unknownIndex = logSession.indexOf("Otherwise, use `unknown`.");

  assert.ok(environmentIndex >= 0, "log-session must read CODEX_THREAD_ID");
  assert.ok(legacyIndex > environmentIndex, "legacy JSONL must be the second choice");
  assert.ok(unknownIndex > legacyIndex, "unknown must be the final fallback");
  assert.match(
    logSession,
    /\| Present \| Missing \| `CODEX_THREAD_ID` \| Current date\/time \| `unavailable` \|/u,
  );
  assert.match(
    logSession,
    /\| Missing \| Present \| `SessionStart\.session_id` \| `SessionStart\.timestamp` \| `logs\/sessions\/\{filename\}` \|/u,
  );
  assert.match(
    logSession,
    /\| Missing \| Missing \| `unknown` \| Current date\/time \| `unavailable` \|/u,
  );
});
