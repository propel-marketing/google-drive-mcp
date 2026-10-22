import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxEntryPoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const architectureRunnerScript = join(repoRoot, '.agents', 'scripts', 'architecture-runner.ts');

const runDate = '2026-10-17';
const runSlug = 'paths';
const runDirectoryName = `${runDate}-${runSlug}`;
const defaultArchitectureRoot = join('.agents', 'runs', 'architecture');
const phaseDirectoryNames = ['inventory', 'diagnose', 'plan', 'issues', 'spec'];

interface RunnerCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | undefined;
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function runArchitectureRunner(root: string, args: string[]): RunnerCliResult {
  const spawned = spawnSync(process.execPath, [tsxEntryPoint, architectureRunnerScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_AGENT_ROOT: root },
    encoding: 'utf8',
  });
  return {
    status: spawned.status,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    json: parseJsonText(spawned.stdout),
  };
}

function runInit(root: string, date: string, featureSlug: string, ...rootArgs: string[]): RunnerCliResult {
  return runArchitectureRunner(root, ['init', '--date', date, '--feature-slug', featureSlug, ...rootArgs]);
}

async function createValidatedRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-architecture-runner-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents'), { recursive: true });
  return root;
}

function assertRuntimePathRefusal(result: RunnerCliResult, code: string, step: string): Record<string, unknown> {
  assert.notEqual(result.status, 0, `${step} must exit non-zero`);
  assert.equal(result.stdout, '', `${step} printed to stdout: ${result.stdout}`);
  const refusal = parseJsonText(result.stderr);
  assert.ok(refusal, `${step} printed no JSON error: ${result.stderr}`);
  assert.equal(refusal.code, code, `${step} reported the wrong code: ${result.stderr}`);
  assert.equal(typeof refusal.error, 'string');
  assert.equal(typeof refusal.nextAction, 'string');
  return refusal;
}

async function assertNothingCreated(root: string): Promise<void> {
  assert.deepEqual(await readdir(root), ['.agents']);
  assert.deepEqual(await readdir(join(root, '.agents')), []);
  assert.equal(existsSync(join(root, runDirectoryName)), false);
  assert.equal(existsSync(join(repoRoot, runDirectoryName)), false);
}

test('init refuses the project root as the architecture root and creates nothing', async (t) => {
  const root = await createValidatedRoot(t);

  const refusedAlias = runInit(root, runDate, runSlug, '--root', root);
  assertRuntimePathRefusal(refusedAlias, 'PLAN_ROOT_OUTSIDE_RUNS', 'init --root <project root>');
  await assertNothingCreated(root);

  const refusedOption = runInit(root, runDate, runSlug, '--architecture-root', root);
  assertRuntimePathRefusal(refusedOption, 'PLAN_ROOT_OUTSIDE_RUNS', 'init --architecture-root <project root>');
  await assertNothingCreated(root);

  const refusedParent = runInit(root, runDate, runSlug, '--architecture-root', join('.agents', 'runs', '..'));
  assertRuntimePathRefusal(refusedParent, 'PLAN_ROOT_OUTSIDE_RUNS', 'init --architecture-root .agents/runs/..');
  await assertNothingCreated(root);
});

test('init refuses a feature slug that is not a slug', async (t) => {
  const root = await createValidatedRoot(t);

  const refused = runInit(root, runDate, 'bad/slug');
  assertRuntimePathRefusal(refused, 'PLAN_NAME_INVALID', 'init --feature-slug bad/slug');
  await assertNothingCreated(root);
});

test('init refuses a date that is not YYYY-MM-DD', async (t) => {
  const root = await createValidatedRoot(t);

  const refused = runInit(root, '17-10-2026', runSlug);
  assertRuntimePathRefusal(refused, 'PLAN_NAME_INVALID', 'init --date 17-10-2026');
  await assertNothingCreated(root);
});

test('init creates the run under .agents/runs/architecture and list-runs lists it', async (t) => {
  const root = await createValidatedRoot(t);

  const created = runInit(root, runDate, runSlug);
  assert.equal(created.status, 0, `init exited ${created.status}: ${created.stderr}`);
  assert.ok(created.json, `init printed no JSON: ${created.stdout}`);
  assert.equal(created.json.created, true);
  const outputDir = created.json.outputDir;
  assert.equal(typeof outputDir, 'string');
  assert.equal(basename(outputDir as string), runDirectoryName);
  assert.equal(basename(dirname(outputDir as string)), 'architecture');
  for (const phase of phaseDirectoryNames) {
    assert.equal(existsSync(join(root, defaultArchitectureRoot, runDirectoryName, phase)), true, `${phase} directory missing`);
  }
  assert.deepEqual(await readdir(root), ['.agents']);
  assert.equal(existsSync(join(repoRoot, defaultArchitectureRoot, runDirectoryName)), false);

  const listed = runArchitectureRunner(root, ['list-runs']);
  assert.equal(listed.status, 0, `list-runs exited ${listed.status}: ${listed.stderr}`);
  assert.ok(listed.json, `list-runs printed no JSON: ${listed.stdout}`);
  const runs = listed.json.runs as Array<{ name: string; path: string }>;
  assert.deepEqual(runs.map((run) => run.name), [runDirectoryName]);

  const listedExplicitly = runArchitectureRunner(root, ['list-runs', '--architecture-root', defaultArchitectureRoot]);
  assert.equal(listedExplicitly.status, 0, `list-runs --architecture-root exited ${listedExplicitly.status}: ${listedExplicitly.stderr}`);
  assert.deepEqual(listedExplicitly.json, listed.json);

  const refusedListing = runArchitectureRunner(root, ['list-runs', '--root', root]);
  assertRuntimePathRefusal(refusedListing, 'PLAN_ROOT_OUTSIDE_RUNS', 'list-runs --root <project root>');
});
