import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxEntryPoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tasksCliScript = join(repoRoot, '.agents', 'scripts', 'tasks.ts');

const smokePlanName = 'smoke-plan';
const smokeTaskId = 'smoke-01';
const smokeOutputFileName = 'smoke-output.txt';
const smokeAgentSystemReadPath = join('.agents', 'runs', smokePlanName, 'AGENT_SYSTEM.md');
const smokeSpecReadPath = join('.agents', 'runs', smokePlanName, 'spec', 'universal-spec.md');

const smokeTaskDescription = [
  'This smoke task exercises the managed task lifecycle of the ADW task runtime end to end through the real command line entry point.',
  'The builder first creates the task with two required reads and one expected output file, then fetches it with get to confirm the stored contract.',
  'The builder marks the task in progress with start, which records the caller, the claim, the start timestamp and the first heartbeat on the task row.',
  'Each required read is logged with log-read so that the completion validator can confirm the builder consulted the agent system context and the spec.',
  'The builder then writes the expected output file containing the SMOKE_OK marker and logs that mutation with log-mutation against the declared expected path.',
  'Finally the builder calls complete with discovered context and a self audit, and the validator checks reads, expected files, required symbols and the JSON payloads.',
  'Every write that the runtime performs during this lifecycle must land under the configured root, which is a temporary directory owned by the test and removed afterwards.',
  'The repository checkout that hosts the runtime scripts must never gain a smoke plan directory or any database row from this exercise.',
  'If any step fails the test reports the structured JSON error that the command line printed so that the failure can be diagnosed from the test output alone.',
].join(' ');

const smokeDiscoveredContext = JSON.stringify({
  driftFromTDD: [],
  filesCreated: [smokeOutputFileName],
  filesModified: [],
  decisionsNotInTDD: [],
});

const smokeSelfAudit = JSON.stringify({
  assumptions: 'none',
  shortcuts: 'none',
  patternAlignment: 'aligned',
});

interface TasksCliResult {
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

export function runTasksCli(root: string, args: string[], cwd: string = repoRoot): TasksCliResult {
  const spawned = spawnSync(process.execPath, [tsxEntryPoint, tasksCliScript, ...args], {
    cwd,
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

function assertCliSucceeded(result: TasksCliResult, step: string): Record<string, unknown> {
  assert.equal(result.status, 0, `${step} exited ${result.status}: ${result.stderr}`);
  assert.ok(result.json, `${step} printed no JSON: ${result.stdout}`);
  assert.equal(result.json.success, true, `${step} did not report success: ${result.stdout}`);
  return result.json;
}

function taskFromResult(payload: Record<string, unknown>): Record<string, unknown> {
  const task = payload.task;
  assert.ok(task && typeof task === 'object', `payload carries no task: ${JSON.stringify(payload)}`);
  return task as Record<string, unknown>;
}

async function createSmokeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-runtime-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents', 'runs', smokePlanName, 'spec'), { recursive: true });
  await writeFile(join(root, smokeAgentSystemReadPath), '# Agent System Context for the smoke plan\n', 'utf8');
  await writeFile(join(root, smokeSpecReadPath), '# Universal Spec for the smoke plan\n', 'utf8');
  return root;
}

function assertRuntimePathRefusal(result: TasksCliResult, code: string, step: string): Record<string, unknown> {
  assert.notEqual(result.status, 0, `${step} must exit non-zero`);
  assert.equal(result.stdout, '', `${step} printed to stdout: ${result.stdout}`);
  const refusal = parseJsonText(result.stderr);
  assert.ok(refusal, `${step} printed no JSON error: ${result.stderr}`);
  assert.equal(refusal.code, code, `${step} reported the wrong code: ${result.stderr}`);
  assert.equal(typeof refusal.error, 'string');
  assert.equal(typeof refusal.nextAction, 'string');
  return refusal;
}

function createSmokeTask(root: string, planName: string = smokePlanName): TasksCliResult {
  const expectedOutput = JSON.stringify({
    path: join(root, smokeOutputFileName),
    op: 'create',
    symbolsRequired: ['SMOKE_OK'],
  });
  return runTasksCli(root, [
    'create',
    '--plan', planName,
    '--task-id', smokeTaskId,
    '--subject', 'Smoke task',
    '--description', smokeTaskDescription,
    '--active-form', 'running smoke task',
    '--assigned-to', 'builder',
    '--layer', 'config',
    '--required-reads', smokeAgentSystemReadPath,
    '--required-reads', smokeSpecReadPath,
    '--files-expected', expectedOutput,
  ]);
}

function startSmokeTask(root: string): TasksCliResult {
  return runTasksCli(root, ['start', '--plan', smokePlanName, '--task-id', smokeTaskId, '--caller', 'builder']);
}

function completeSmokeTask(root: string): TasksCliResult {
  return runTasksCli(root, [
    'complete',
    '--plan', smokePlanName,
    '--task-id', smokeTaskId,
    '--caller', 'builder',
    '--discovered-context', smokeDiscoveredContext,
    '--self-audit', smokeSelfAudit,
  ]);
}

function listSmokePlan(root: string): Record<string, unknown>[] {
  const listed = assertCliSucceeded(runTasksCli(root, ['list', '--plan', smokePlanName]), 'list');
  assert.ok(Array.isArray(listed.tasks), `list printed no tasks array: ${JSON.stringify(listed)}`);
  return listed.tasks as Record<string, unknown>[];
}

test('task lifecycle completes against a temporary root', async (t) => {
  const root = await createSmokeRoot(t);
  assert.ok(smokeTaskDescription.length >= 900);

  const created = taskFromResult(assertCliSucceeded(createSmokeTask(root), 'create'));
  assert.equal(created.status, 'pending');
  assert.deepEqual(created.requiredReads, [smokeAgentSystemReadPath, smokeSpecReadPath]);
  assert.equal((created.filesExpected as unknown[]).length, 1);

  const fetched = taskFromResult(assertCliSucceeded(
    runTasksCli(root, ['get', '--plan', smokePlanName, '--task-id', smokeTaskId]),
    'get',
  ));
  assert.equal(fetched.taskId, smokeTaskId);
  assert.equal(fetched.description, smokeTaskDescription);

  const started = taskFromResult(assertCliSucceeded(startSmokeTask(root), 'start'));
  assert.equal(started.status, 'in_progress');
  assert.equal(started.claimedBy, 'builder');

  const firstRead = assertCliSucceeded(
    runTasksCli(root, ['log-read', '--plan', smokePlanName, '--task-id', smokeTaskId, '--path', smokeAgentSystemReadPath]),
    'log-read AGENT_SYSTEM.md',
  );
  assert.equal((firstRead.filesRead as unknown[]).length, 1);
  const secondRead = assertCliSucceeded(
    runTasksCli(root, ['log-read', '--plan', smokePlanName, '--task-id', smokeTaskId, '--path', smokeSpecReadPath]),
    'log-read universal-spec.md',
  );
  assert.equal((secondRead.filesRead as unknown[]).length, 2);

  const outputPath = join(root, smokeOutputFileName);
  await writeFile(outputPath, 'SMOKE_OK\n', 'utf8');
  const mutation = assertCliSucceeded(
    runTasksCli(root, ['log-mutation', '--plan', smokePlanName, '--task-id', smokeTaskId, '--path', outputPath]),
    'log-mutation',
  );
  assert.equal((mutation.fileMutations as unknown[]).length, 1);

  const completed = taskFromResult(assertCliSucceeded(completeSmokeTask(root), 'complete'));
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);

  const listedTask = listSmokePlan(root).find((task) => task.taskId === smokeTaskId);
  assert.ok(listedTask, 'list did not include the smoke task');
  assert.equal(listedTask.status, 'completed');
});

test('complete refuses when a required read was not logged', async (t) => {
  const root = await createSmokeRoot(t);
  assertCliSucceeded(createSmokeTask(root), 'create');
  assertCliSucceeded(startSmokeTask(root), 'start');
  await writeFile(join(root, smokeOutputFileName), 'SMOKE_OK\n', 'utf8');

  const refused = completeSmokeTask(root);
  assert.notEqual(refused.status, 0, 'complete must fail when required reads are missing');
  assert.equal(refused.json, undefined, `complete printed success output: ${refused.stdout}`);
  const refusal = parseJsonText(refused.stderr);
  assert.ok(refusal, `complete printed no JSON error: ${refused.stderr}`);
  assert.equal(refusal.error, 'Task completion contract failed');
  const failures = refusal.failures as string[];
  assert.ok(Array.isArray(failures));
  assert.ok(failures.some((failure) => failure.includes(`required read missing: ${smokeAgentSystemReadPath}`)), failures.join('\n'));
  assert.ok(failures.some((failure) => failure.includes(`required read missing: ${smokeSpecReadPath}`)), failures.join('\n'));

  const listedTask = listSmokePlan(root).find((task) => task.taskId === smokeTaskId);
  assert.ok(listedTask, 'list did not include the smoke task');
  assert.equal(listedTask.status, 'in_progress');
});

test('the CLI writes only under the configured root', async (t) => {
  const root = await createSmokeRoot(t);
  assertCliSucceeded(createSmokeTask(root), 'create');
  assertCliSucceeded(startSmokeTask(root), 'start');

  assert.equal(existsSync(join(root, '.agents', 'data', 'tasks.db')), true);
  assert.equal(existsSync(join(root, '.agents', 'runs', smokePlanName, 'task-list.json')), true);
  assert.equal(existsSync(join(repoRoot, '.agents', 'runs', smokePlanName)), false);
  assert.equal(existsSync(join(repoRoot, smokeOutputFileName)), false);
});

test('a relative CODEX_AGENT_ROOT is refused before anything is created', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'adw-runtime-smoke-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const relativeRoot = 'smoke-relative-root';
  const before = await readdir(parent);

  const refused = runTasksCli(relativeRoot, ['status'], parent);
  assertRuntimePathRefusal(refused, 'ROOT_NOT_ABSOLUTE', 'status with a relative root');

  assert.deepEqual(await readdir(parent), before);
  assert.equal(existsSync(join(parent, relativeRoot)), false);
  assert.equal(existsSync(join(repoRoot, relativeRoot)), false);
});

test('create refuses a plan name that is not a slug and creates nothing', async (t) => {
  const root = await createSmokeRoot(t);
  const invalidPlanName = '$plan';

  const refused = createSmokeTask(root, invalidPlanName);
  assertRuntimePathRefusal(refused, 'PLAN_NAME_INVALID', 'create with an invalid plan name');

  assert.deepEqual(await readdir(join(root, '.agents', 'runs')), [smokePlanName]);
  assert.equal(existsSync(join(root, '.agents', 'data')), false);
  assert.equal(existsSync(join(repoRoot, '.agents', 'runs', invalidPlanName)), false);
});

function spellRootThreeWays(root: string): string[] {
  if (process.platform === 'win32') {
    const forwardSlashes = root.replace(/\\/g, '/');
    const msysForm = `/${forwardSlashes[0].toLowerCase()}${forwardSlashes.slice(2)}`;
    return [root, forwardSlashes, msysForm];
  }
  return [root, `${root}/`, `${dirname(root)}/./${basename(root)}`];
}

test('the same root spelled three ways resolves to one plan', async (t) => {
  const root = await createSmokeRoot(t);
  const [firstSpelling, ...otherSpellings] = spellRootThreeWays(root);
  assert.equal(otherSpellings.length, 2);
  assert.ok(otherSpellings.every((spelling) => spelling !== firstSpelling));

  assertCliSucceeded(createSmokeTask(firstSpelling), 'create');
  const firstSummary = assertCliSucceeded(runTasksCli(firstSpelling, ['summary', '--plan', smokePlanName]), 'summary');
  assert.equal(typeof firstSummary.projectDir, 'string');

  for (const spelling of otherSpellings) {
    const listed = assertCliSucceeded(runTasksCli(spelling, ['list', '--plan', smokePlanName]), `list under ${spelling}`);
    const tasks = listed.tasks as Record<string, unknown>[];
    assert.ok(tasks.some((task) => task.taskId === smokeTaskId), `list under ${spelling} did not find the smoke task`);
    const summary = assertCliSucceeded(runTasksCli(spelling, ['summary', '--plan', smokePlanName]), `summary under ${spelling}`);
    assert.equal(summary.projectDir, firstSummary.projectDir);
    assert.equal((summary.counts as Record<string, unknown>).total, 1);
  }

  assert.deepEqual(await readdir(join(root, '.agents', 'runs')), [smokePlanName]);
});
