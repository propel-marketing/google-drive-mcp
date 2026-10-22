import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxEntryPoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runnerScript = join(repoRoot, '.agents', 'scripts', 'task-orchestration-runner.ts');
const workflowRunnerScript = join(repoRoot, '.agents', 'scripts', 'workflow-runner.ts');
const contractsDirectory = join('.agents', 'contracts');
const runsDirectory = join('.agents', 'runs');
const registryFile = join('.agents', 'active-plans.json');
const smokePlanName = 'smoke-runner';

interface RunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function runRunner(root: string, args: string[], script = runnerScript): RunnerResult {
  const spawned = spawnSync(process.execPath, [tsxEntryPoint, script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_AGENT_ROOT: root },
    encoding: 'utf8',
  });
  return { status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr };
}

function materialize(root: string, planName: string, stage: string, planRoot?: string): RunnerResult {
  const args = ['materialize', '--plan-name', planName, '--stage', stage];
  if (planRoot) args.push('--plan-root', planRoot);
  return runRunner(root, args);
}

async function createValidatedRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-runner-plan-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repoRoot, contractsDirectory), join(root, contractsDirectory), { recursive: true });
  return realpathSync.native(root);
}

function assertRuntimePathRefusal(result: RunnerResult, code: string, step: string): void {
  assert.notEqual(result.status, 0, `${step} must exit non-zero`);
  assert.equal(result.stdout, '', `${step} printed to stdout: ${result.stdout}`);
  const refusal = parseJsonText(result.stderr);
  assert.ok(refusal, `${step} printed no JSON error: ${result.stderr}`);
  assert.equal(refusal.code, code, `${step} reported the wrong code: ${result.stderr}`);
  assert.equal(typeof refusal.error, 'string');
  assert.equal(typeof refusal.nextAction, 'string');
}

function assertNothingCreated(root: string): void {
  assert.equal(existsSync(join(root, runsDirectory)), false, 'a refusal created .agents/runs');
  assert.equal(existsSync(join(root, registryFile)), false, 'a refusal wrote the registry');
  assert.equal(existsSync(join(root, '.agents', 'data')), false, 'a refusal reached tasks.ts');
}

function assertMaterialized(result: RunnerResult, step: string): Record<string, unknown> {
  assert.equal(result.status, 0, `${step} exited ${result.status}: ${result.stderr}`);
  const payload = parseJsonText(result.stdout);
  assert.ok(payload, `${step} printed no JSON: ${result.stdout}`);
  assert.equal(payload.success, true, `${step} did not report success: ${result.stdout}`);
  return payload;
}

test('materialize refuses a plan root outside .agents/runs and creates nothing', async (t) => {
  const root = await createValidatedRoot(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'adw-runner-outside-'));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));

  const refused = materialize(root, 'p', 'execute', outsideDirectory);
  assertRuntimePathRefusal(refused, 'PLAN_ROOT_OUTSIDE_RUNS', 'materialize with an outside plan root');

  assert.deepEqual(await readdir(outsideDirectory), []);
  assertNothingCreated(root);
});

test('materialize refuses a plan name that is not a slug and creates nothing', async (t) => {
  const root = await createValidatedRoot(t);
  const invalidPlanName = '$plan';

  const refused = materialize(root, invalidPlanName, 'execute');
  assertRuntimePathRefusal(refused, 'PLAN_NAME_INVALID', 'materialize with an invalid plan name');

  assertNothingCreated(root);
  assert.equal(existsSync(join(repoRoot, runsDirectory, invalidPlanName)), false);
});

test('materialize creates the plan directory under .agents/runs and registers it relative', async (t) => {
  const root = await createValidatedRoot(t);
  const expectedPlanRoot = join(root, runsDirectory, smokePlanName);

  const payload = assertMaterialized(materialize(root, smokePlanName, 'convert-to-spec'), 'materialize');
  assert.equal(payload.planRoot, expectedPlanRoot);
  assert.equal(payload.tasksCreatedOrVerified, 1);
  assert.equal(existsSync(join(expectedPlanRoot, 'spec')), true);
  assert.equal(existsSync(join(repoRoot, runsDirectory, smokePlanName)), false);

  const registryText = await readFile(join(root, registryFile), 'utf8');
  const registry = JSON.parse(registryText) as { plans: Record<string, { outputDir: string }> };
  assert.equal(registry.plans[smokePlanName]?.outputDir, `.agents/runs/${smokePlanName}`);
  assert.equal(registryText.includes(root.split(sep).join('/')), false);
  assert.equal(registryText.includes(JSON.stringify(root).slice(1, -1)), false);

  const repeated = assertMaterialized(materialize(root, smokePlanName, 'convert-to-spec'), 'repeated materialize');
  assert.equal(repeated.planRoot, expectedPlanRoot);
  assert.deepEqual(await readdir(join(root, runsDirectory)), [smokePlanName]);
});

test('status and materialize refuse an invalid plan name with an explicit plan root and create nothing', async (t) => {
  const root = await createValidatedRoot(t);
  const invalidPlanName = '$plan';
  const explicitPlanRoot = join('.agents', 'runs', smokePlanName);

  const refusedStatus = runRunner(root, ['status', '--plan-name', invalidPlanName, '--plan-root', explicitPlanRoot]);
  assertRuntimePathRefusal(refusedStatus, 'PLAN_NAME_INVALID', 'status with an invalid plan name and an explicit plan root');

  const refusedMaterialize = runRunner(root, ['materialize', '--plan-name', invalidPlanName, '--stage', 'execute', '--plan-root', explicitPlanRoot]);
  assertRuntimePathRefusal(refusedMaterialize, 'PLAN_NAME_INVALID', 'materialize with an invalid plan name and an explicit plan root');

  assertNothingCreated(root);
});

test('workflow runner refuses an invalid plan name with an explicit plan root and creates nothing', async (t) => {
  const root = await createValidatedRoot(t);
  const invalidPlanName = '$plan';
  const explicitPlanRoot = join('.agents', 'runs', smokePlanName);

  const refusedStatus = runRunner(root, ['status', '--plan-name', invalidPlanName, '--plan-root', explicitPlanRoot], workflowRunnerScript);
  assertRuntimePathRefusal(refusedStatus, 'PLAN_NAME_INVALID', 'workflow status with an invalid plan name and an explicit plan root');

  const refusedMaterialize = runRunner(root, ['materialize', '--plan-name', invalidPlanName, '--plan-root', explicitPlanRoot], workflowRunnerScript);
  assertRuntimePathRefusal(refusedMaterialize, 'PLAN_NAME_INVALID', 'workflow materialize with an invalid plan name and an explicit plan root');

  assertNothingCreated(root);
});
