import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxEntryPoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tasksCliScript = join(repoRoot, '.agents', 'scripts', 'tasks.ts');

const ergonomicsPlanName = 'ergonomics-plan';
const ergonomicsTaskId = 'ergonomics-01';
const firstReadPath = join('.agents', 'runs', ergonomicsPlanName, 'AGENT_SYSTEM.md');
const secondReadPath = join('.agents', 'runs', ergonomicsPlanName, 'spec', 'universal-spec.md');
const firstOutputFileName = 'first-output.txt';
const secondOutputFileName = 'second-output.txt';

const ergonomicsDiscoveredContext = {
  driftFromTDD: ['none'],
  filesCreated: [firstOutputFileName, secondOutputFileName],
  filesModified: [],
  decisionsNotInTDD: ['completion payloads read from files'],
};

const ergonomicsSelfAudit = {
  assumptions: 'none',
  shortcuts: 'none',
  patternAlignment: 'aligned',
};

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

function runTasksCli(root: string, args: string[]): TasksCliResult {
  const spawned = spawnSync(process.execPath, [tsxEntryPoint, tasksCliScript, ...args], {
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

function assertCliSucceeded(result: TasksCliResult, step: string): Record<string, unknown> {
  assert.equal(result.status, 0, `${step} exited ${result.status}: ${result.stderr}`);
  assert.ok(result.json, `${step} printed no JSON: ${result.stdout}`);
  assert.equal(result.json.success, true, `${step} did not report success: ${result.stdout}`);
  return result.json;
}

function assertCliRefused(result: TasksCliResult, step: string): Record<string, unknown> {
  assert.equal(result.status, 1, `${step} exited ${result.status}, expected 1: ${result.stderr}`);
  assert.equal(result.stdout, '', `${step} printed to stdout: ${result.stdout}`);
  const refusal = parseJsonText(result.stderr);
  assert.ok(refusal, `${step} printed no JSON error: ${result.stderr}`);
  assert.equal(typeof refusal.error, 'string');
  return refusal;
}

function fetchTask(root: string): Record<string, unknown> {
  const fetched = assertCliSucceeded(runTasksCli(root, ['get', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId]), 'get');
  const task = fetched.task;
  assert.ok(task && typeof task === 'object', `get carried no task: ${JSON.stringify(fetched)}`);
  return task as Record<string, unknown>;
}

async function createErgonomicsRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-runtime-ergonomics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents', 'runs', ergonomicsPlanName, 'spec'), { recursive: true });
  await writeFile(join(root, firstReadPath), '# Agent System Context for the ergonomics plan\n', 'utf8');
  await writeFile(join(root, secondReadPath), '# Universal Spec for the ergonomics plan\n', 'utf8');
  await writeFile(join(root, firstOutputFileName), 'FIRST_OK\n', 'utf8');
  await writeFile(join(root, secondOutputFileName), 'SECOND_OK\n', 'utf8');
  const created = runTasksCli(root, [
    'create',
    '--plan', ergonomicsPlanName,
    '--task-id', ergonomicsTaskId,
    '--subject', 'Ergonomics task',
    '--description', 'Exercises variadic logging and file-based completion payloads.',
    '--active-form', 'running ergonomics task',
    '--assigned-to', 'builder',
    '--layer', 'config',
    '--required-reads', firstReadPath,
    '--required-reads', secondReadPath,
    '--files-expected', JSON.stringify({ path: join(root, firstOutputFileName), op: 'create' }),
    '--files-expected', JSON.stringify({ path: join(root, secondOutputFileName), op: 'create' }),
  ]);
  assertCliSucceeded(created, 'create');
  assertCliSucceeded(runTasksCli(root, ['start', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--caller', 'builder']), 'start');
  return root;
}

async function logBothReadsAndMutations(root: string): Promise<void> {
  assertCliSucceeded(
    runTasksCli(root, ['log-read', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', firstReadPath, secondReadPath]),
    'log-read',
  );
  assertCliSucceeded(
    runTasksCli(root, ['log-mutation', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', join(root, firstOutputFileName), join(root, secondOutputFileName)]),
    'log-mutation',
  );
}

async function writeCompletionFiles(root: string, discoveredContextText: string): Promise<{ discoveredContextFile: string; selfAuditFile: string }> {
  const discoveredContextFile = join(root, 'discovered-context.json');
  const selfAuditFile = join(root, 'self-audit.json');
  await writeFile(discoveredContextFile, discoveredContextText, 'utf8');
  await writeFile(selfAuditFile, JSON.stringify(ergonomicsSelfAudit), 'utf8');
  return { discoveredContextFile, selfAuditFile };
}

function completeTask(root: string, payloadArgs: string[]): TasksCliResult {
  return runTasksCli(root, ['complete', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--caller', 'builder', ...payloadArgs]);
}

test('log-read with two existing paths logs both in one call', async (t) => {
  const root = await createErgonomicsRoot(t);

  const logged = assertCliSucceeded(
    runTasksCli(root, ['log-read', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', firstReadPath, secondReadPath]),
    'log-read',
  );
  assert.equal((logged.filesRead as unknown[]).length, 2);

  const filesRead = fetchTask(root).filesRead as string[];
  assert.equal(filesRead.length, 2);
  assert.ok(filesRead.some((path) => path.endsWith('AGENT_SYSTEM.md')), filesRead.join('\n'));
  assert.ok(filesRead.some((path) => path.endsWith('universal-spec.md')), filesRead.join('\n'));
});

test('log-read with one missing path refuses the whole call and logs nothing', async (t) => {
  const root = await createErgonomicsRoot(t);
  const missingReadPath = join('.agents', 'runs', ergonomicsPlanName, 'missing.md');

  const refusal = assertCliRefused(
    runTasksCli(root, ['log-read', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', firstReadPath, missingReadPath]),
    'log-read with a missing path',
  );
  assert.equal(refusal.error, 'Cannot log read for missing paths');
  assert.deepEqual(refusal.paths, [missingReadPath]);

  assert.deepEqual(fetchTask(root).filesRead, []);
});

test('log-mutation with the two declared paths logs both in one call', async (t) => {
  const root = await createErgonomicsRoot(t);

  const logged = assertCliSucceeded(
    runTasksCli(root, ['log-mutation', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', join(root, firstOutputFileName), join(root, secondOutputFileName)]),
    'log-mutation',
  );
  assert.equal((logged.fileMutations as unknown[]).length, 2);

  const fileMutations = fetchTask(root).fileMutations as string[];
  assert.equal(fileMutations.length, 2);
  assert.ok(fileMutations.some((path) => path.endsWith(firstOutputFileName)), fileMutations.join('\n'));
  assert.ok(fileMutations.some((path) => path.endsWith(secondOutputFileName)), fileMutations.join('\n'));
});

test('log-mutation with one undeclared path refuses the whole call and logs nothing', async (t) => {
  const root = await createErgonomicsRoot(t);
  const undeclaredPath = join(root, 'undeclared-output.txt');
  await writeFile(undeclaredPath, 'UNDECLARED\n', 'utf8');

  const refusal = assertCliRefused(
    runTasksCli(root, ['log-mutation', '--plan', ergonomicsPlanName, '--task-id', ergonomicsTaskId, '--path', join(root, firstOutputFileName), undeclaredPath]),
    'log-mutation with an undeclared path',
  );
  assert.equal(refusal.error, 'Mutation paths are not declared in filesExpected and are not under the plan agent-outputs directory.');
  assert.deepEqual(refusal.paths, [undeclaredPath]);

  assert.deepEqual(fetchTask(root).fileMutations, []);
});

test('complete reads both payloads from files', async (t) => {
  const root = await createErgonomicsRoot(t);
  await logBothReadsAndMutations(root);
  const { discoveredContextFile, selfAuditFile } = await writeCompletionFiles(root, JSON.stringify(ergonomicsDiscoveredContext));

  const completed = assertCliSucceeded(
    completeTask(root, ['--discovered-context-file', discoveredContextFile, '--self-audit-file', selfAuditFile]),
    'complete with payload files',
  );
  const task = completed.task as Record<string, unknown>;
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.discoveredContext, ergonomicsDiscoveredContext);
  assert.deepEqual(task.selfAudit, ergonomicsSelfAudit);
  assert.equal(fetchTask(root).status, 'completed');
});

test('complete requires exactly one source per payload', async (t) => {
  const root = await createErgonomicsRoot(t);
  await logBothReadsAndMutations(root);
  const { discoveredContextFile, selfAuditFile } = await writeCompletionFiles(root, JSON.stringify(ergonomicsDiscoveredContext));

  const bothGiven = assertCliRefused(
    completeTask(root, [
      '--discovered-context', JSON.stringify(ergonomicsDiscoveredContext),
      '--discovered-context-file', discoveredContextFile,
      '--self-audit-file', selfAuditFile,
    ]),
    'complete with inline and file discovered context',
  );
  assert.equal(bothGiven.error, 'pass exactly one of --discovered-context or --discovered-context-file');

  const neitherGiven = assertCliRefused(
    completeTask(root, ['--discovered-context-file', discoveredContextFile]),
    'complete without a self audit source',
  );
  assert.equal(neitherGiven.error, 'pass exactly one of --self-audit or --self-audit-file');

  assert.equal(fetchTask(root).status, 'in_progress');
});

test('complete refuses a payload file holding invalid JSON', async (t) => {
  const root = await createErgonomicsRoot(t);
  await logBothReadsAndMutations(root);
  const { discoveredContextFile, selfAuditFile } = await writeCompletionFiles(root, '{ "driftFromTDD": [ ');

  const refusal = assertCliRefused(
    completeTask(root, ['--discovered-context-file', discoveredContextFile, '--self-audit-file', selfAuditFile]),
    'complete with an invalid discovered context file',
  );
  assert.ok((refusal.error as string).startsWith('--discovered-context-file not valid JSON: '), refusal.error as string);
  assert.ok((refusal.error as string).includes(discoveredContextFile), refusal.error as string);

  assert.equal(fetchTask(root).status, 'in_progress');
});

test('complete refuses a payload path that exists but is not readable', async (t) => {
  const root = await createErgonomicsRoot(t);
  await logBothReadsAndMutations(root);
  const { selfAuditFile } = await writeCompletionFiles(root, JSON.stringify(ergonomicsDiscoveredContext));
  const unreadableDiscoveredContextPath = join(root, 'discovered-context-directory');
  await mkdir(unreadableDiscoveredContextPath);

  const refusal = assertCliRefused(
    completeTask(root, ['--discovered-context-file', unreadableDiscoveredContextPath, '--self-audit-file', selfAuditFile]),
    'complete with a directory as the discovered context file',
  );
  assert.ok((refusal.error as string).startsWith('--discovered-context-file not readable: '), refusal.error as string);
  assert.ok((refusal.error as string).includes(unreadableDiscoveredContextPath), refusal.error as string);

  assert.equal(fetchTask(root).status, 'in_progress');
});
