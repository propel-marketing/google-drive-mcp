import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  type ActivePlanRecord,
  type ActivePlansRegistry,
  activePlansRegistryPath,
  listActivePlans,
  resolveActivePlan,
  resolvePlanRoot,
  runLocalJson,
  upsertActivePlan,
} from '../runner-helpers';
import { isRuntimePathError } from '../runtime-paths';

const planName = 'runner-helpers-plan';
const nodeModulesBinSegment = `node_modules${sep}.bin`;
const tsxLauncherNames = ['tsx', 'tsx.cmd', 'tsx.exe', 'tsx.ps1'];

function stripTsxLaunchersFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((segment) => !segment.replace(/\//g, sep).includes(nodeModulesBinSegment))
    .filter((segment) => !tsxLauncherNames.some((launcher) => existsSync(join(segment, launcher))))
    .join(delimiter);
}

function restoreEnvironmentValue(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function createValidatedRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-runner-helpers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents', 'runs'), { recursive: true });
  const previousRoot = process.env.CODEX_AGENT_ROOT;
  process.env.CODEX_AGENT_ROOT = root;
  t.after(() => restoreEnvironmentValue('CODEX_AGENT_ROOT', previousRoot));
  return realpathSync.native(root);
}

function activePlanRecord(outputDir: string): ActivePlanRecord {
  return {
    planName,
    outputDir,
    kind: 'task-orchestration',
    mode: 'execute',
    updatedAt: '2026-10-17T00:00:00.000Z',
    status: 'active',
    stopGuard: true,
    runner: 'task-orchestration-runner.ts',
  };
}

async function readRegistryFile(): Promise<ActivePlansRegistry> {
  return JSON.parse(await readFile(activePlansRegistryPath(), 'utf8')) as ActivePlansRegistry;
}

test('runLocalJson spawns tasks.ts through node without tsx on PATH', async (t) => {
  await createValidatedRoot(t);
  const previousPath = process.env.PATH;
  process.env.PATH = stripTsxLaunchersFromPath(previousPath ?? '');
  t.after(() => restoreEnvironmentValue('PATH', previousPath));
  assert.equal(process.env.PATH.includes(nodeModulesBinSegment), false);
  for (const segment of process.env.PATH.split(delimiter)) {
    for (const launcher of tsxLauncherNames) {
      assert.equal(existsSync(join(segment, launcher)), false, `${launcher} is still reachable through PATH`);
    }
  }

  const listed = runLocalJson(['list', '--plan', planName]) as { success: boolean; count: number; tasks: unknown[] };
  assert.equal(listed.success, true);
  assert.equal(listed.count, 0);
  assert.deepEqual(listed.tasks, []);
});

test('runLocalJson surfaces a failing tasks.ts command with its stderr', async (t) => {
  await createValidatedRoot(t);
  assert.throws(
    () => runLocalJson(['summary', '--plan', planName]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('[runner-helpers.runLocalJson]') &&
      error.message.includes('exited 1') &&
      error.message.includes(`Plan '${planName}' not found`),
  );
});

test('resolvePlanRoot accepts a plan directory inside .agents/runs', async (t) => {
  const root = await createValidatedRoot(t);
  const planRoot = resolvePlanRoot(join('.agents', 'runs', 'x'));
  assert.equal(planRoot, resolve(root, '.agents', 'runs', 'x'));
});

test('resolvePlanRoot refuses a plan directory outside .agents/runs', async (t) => {
  await createValidatedRoot(t);
  assert.throws(
    () => resolvePlanRoot(join('..', 'x')),
    (error: unknown) => isRuntimePathError(error) && error.code === 'PLAN_ROOT_OUTSIDE_RUNS',
  );
});

test('upsertActivePlan stores a relative forward-slash outputDir and reads it back absolute', async (t) => {
  const root = await createValidatedRoot(t);
  const absoluteOutputDir = join(root, '.agents', 'runs', planName);
  upsertActivePlan(activePlanRecord(absoluteOutputDir));

  const stored = (await readRegistryFile()).plans[planName];
  assert.ok(stored, 'registry file has no record for the plan');
  assert.equal(stored.outputDir, `.agents/runs/${planName}`);
  assert.equal(JSON.stringify(await readRegistryFile()).includes(root.split(sep).join('/')), false);
  assert.equal(JSON.stringify(await readRegistryFile()).includes(JSON.stringify(root).slice(1, -1)), false);

  const resolved = resolveActivePlan('task-orchestration', planName);
  assert.ok(resolved, 'resolveActivePlan returned no record');
  assert.equal(resolved.outputDir, absoluteOutputDir);
  assert.equal(listActivePlans('task-orchestration')[0]?.outputDir, absoluteOutputDir);
});

test('a registry holding an absolute outputDir still reads back as that absolute path', async (t) => {
  const root = await createValidatedRoot(t);
  const absoluteOutputDir = join(root, '.agents', 'runs', 'legacy-plan');
  const legacyRegistry: ActivePlansRegistry = { plans: { 'legacy-plan': { ...activePlanRecord(absoluteOutputDir), planName: 'legacy-plan' } } };
  await writeFile(activePlansRegistryPath(), JSON.stringify(legacyRegistry, null, 2), 'utf8');

  const resolved = resolveActivePlan('task-orchestration', 'legacy-plan');
  assert.ok(resolved, 'resolveActivePlan returned no record');
  assert.equal(resolved.outputDir, absoluteOutputDir);
});
