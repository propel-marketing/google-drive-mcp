import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  DATE_PATTERN,
  PLAN_SLUG_PATTERN,
  RUNS_DIRECTORY,
  RuntimePathError,
  assertDateToken,
  assertPlanSlug,
  canonicalizeRootCandidate,
  formatRuntimePathError,
  fromRegistryOutputDir,
  isRuntimePathError,
  resolvePlanRootWithinRuns,
  resolveValidatedProjectRoot,
  toRegistryOutputDir,
} from '../runtime-paths';

const win32 = process.platform === 'win32';

async function createTemporaryRoot(t: test.TestContext, withAgents = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-runtime-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (withAgents) await mkdir(join(root, '.agents', 'runs'), { recursive: true });
  return root;
}

function expectRuntimePathError(action: () => unknown, code: RuntimePathError['code'], offendingValue: string): RuntimePathError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(isRuntimePathError(caught), `expected RuntimePathError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.ok(caught.message.includes(offendingValue), `message "${caught.message}" does not name "${offendingValue}"`);
  assert.ok(caught.nextAction.length > 0, 'nextAction is empty');
  return caught;
}

function msysSpelling(windowsPath: string): string {
  return windowsPath.replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

test('resolveValidatedProjectRoot refuses drive-relative and collapsed roots', () => {
  for (const candidate of ['D:name', 'DMy Code ProjectsSpark-ADW']) {
    expectRuntimePathError(() => resolveValidatedProjectRoot(candidate), 'ROOT_NOT_ABSOLUTE', candidate);
  }
});

test('resolveValidatedProjectRoot refuses a relative name, an empty value and whitespace', () => {
  for (const candidate of ['checkout', '.', '', '   ']) {
    expectRuntimePathError(() => resolveValidatedProjectRoot(candidate), 'ROOT_NOT_ABSOLUTE', candidate.trim());
  }
});

test('resolveValidatedProjectRoot refuses an absolute path that does not exist', async (t) => {
  const root = await createTemporaryRoot(t);
  const missing = join(root, 'missing-checkout');
  expectRuntimePathError(() => resolveValidatedProjectRoot(missing), 'ROOT_MISSING', missing);
});

test('resolveValidatedProjectRoot refuses a directory without .agents', async (t) => {
  const root = await createTemporaryRoot(t, false);
  const refusal = expectRuntimePathError(() => resolveValidatedProjectRoot(root), 'ROOT_NOT_ADW', '.agents');
  assert.ok(refusal.nextAction.includes('.agents'));
});

test('resolveValidatedProjectRoot accepts a temporary checkout and returns its canonical form', async (t) => {
  const root = await createTemporaryRoot(t);
  const canonical = resolveValidatedProjectRoot(root);
  assert.equal(canonical, canonicalizeRootCandidate(root));
  assert.equal(resolveValidatedProjectRoot(`  ${root}  `), canonical);
  assert.equal(resolveValidatedProjectRoot(join(root, 'runs-sibling', '..')), canonical);
});

test('resolveValidatedProjectRoot reads CODEX_AGENT_ROOT when no candidate is passed', async (t) => {
  const root = await createTemporaryRoot(t);
  const previous = process.env.CODEX_AGENT_ROOT;
  process.env.CODEX_AGENT_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_AGENT_ROOT;
    else process.env.CODEX_AGENT_ROOT = previous;
  });
  assert.equal(resolveValidatedProjectRoot(), canonicalizeRootCandidate(root));
  process.env.CODEX_AGENT_ROOT = 'D:name';
  expectRuntimePathError(() => resolveValidatedProjectRoot(), 'ROOT_NOT_ABSOLUTE', 'D:name');
});

test('win32 spellings of one root resolve to one canonical string', { skip: !win32 }, async (t) => {
  const root = await createTemporaryRoot(t);
  const canonical = resolveValidatedProjectRoot(root);
  const backslashForm = canonical;
  const forwardSlashForm = canonical.replace(/\\/g, '/');
  const msysForm = msysSpelling(canonical);
  assert.match(backslashForm, /^[A-Z]:\\/);
  assert.match(msysForm, /^\/[a-z]\//);
  assert.equal(resolveValidatedProjectRoot(forwardSlashForm), canonical);
  assert.equal(resolveValidatedProjectRoot(msysForm), canonical);
  assert.equal(resolveValidatedProjectRoot(canonical.charAt(0).toLowerCase() + canonical.slice(1)), canonical);
  expectRuntimePathError(() => resolveValidatedProjectRoot(canonical.slice(2)), 'ROOT_NOT_ABSOLUTE', canonical.slice(2));
});

test('posix roots accept a trailing slash as the same root', { skip: win32 }, async (t) => {
  const root = await createTemporaryRoot(t);
  const canonical = resolveValidatedProjectRoot(root);
  assert.match(canonical, /^\//);
  assert.equal(resolveValidatedProjectRoot(`${root}/`), canonical);
  assert.equal(resolveValidatedProjectRoot(`${root}//`), canonical);
});

test('assertPlanSlug refuses shell tokens, placeholders, separators and blanks', () => {
  for (const candidate of ['$plan', '$p', '.agents/runs$P', '{PLAN_ROOT}', '', '   ', 'a:b', 'a\\b', 'a/b', '../x', 'Upper-Case']) {
    const refusal = expectRuntimePathError(() => assertPlanSlug(candidate, '--plan'), 'PLAN_NAME_INVALID', candidate);
    assert.ok(refusal.message.startsWith('--plan '), refusal.message);
    assert.ok(refusal.nextAction.includes('--plan'), refusal.nextAction);
  }
  expectRuntimePathError(() => assertPlanSlug(undefined as unknown as string, '--plan-name'), 'PLAN_NAME_INVALID', 'undefined');
});

test('assertPlanSlug accepts real plan names and returns them unchanged', () => {
  for (const candidate of ['r521-gbp-reviews-insights-exports', 'architecture-2026-08-27-gbp-posts', 'smoke-plan', 'adw-phase1-path-validation']) {
    assert.equal(assertPlanSlug(candidate, '--plan'), candidate);
    assert.match(candidate, PLAN_SLUG_PATTERN);
  }
});

test('assertDateToken accepts YYYY-MM-DD and refuses other shapes', () => {
  assert.equal(assertDateToken('2026-10-17', '--date'), '2026-10-17');
  assert.match('2026-10-17', DATE_PATTERN);
  for (const candidate of ['2026-1-7', '20261017', '$date', '', '2026-10-17T00:00']) {
    expectRuntimePathError(() => assertDateToken(candidate, '--date'), 'PLAN_NAME_INVALID', candidate);
  }
});

test('resolvePlanRootWithinRuns accepts relative and absolute plan roots inside .agents/runs', async (t) => {
  const root = resolveValidatedProjectRoot(await createTemporaryRoot(t));
  const expected = resolve(root, RUNS_DIRECTORY, 'x');
  assert.equal(resolvePlanRootWithinRuns(root, `${RUNS_DIRECTORY}/x`), expected);
  assert.equal(resolvePlanRootWithinRuns(root, expected), expected);
  assert.equal(resolvePlanRootWithinRuns(root, join(RUNS_DIRECTORY, 'x', 'nested')), join(expected, 'nested'));
  await mkdir(expected, { recursive: true });
  assert.equal(resolvePlanRootWithinRuns(root, `${RUNS_DIRECTORY}/x/`), expected);
});

test('resolvePlanRootWithinRuns refuses parents, the root, the runs directory and outside paths', async (t) => {
  const root = resolveValidatedProjectRoot(await createTemporaryRoot(t));
  const outside = await createTemporaryRoot(t, false);
  for (const candidate of ['..', '.', '', RUNS_DIRECTORY, `${RUNS_DIRECTORY}/../x`, '.agents', root, outside, join(outside, 'plan')]) {
    const refusal = expectRuntimePathError(() => resolvePlanRootWithinRuns(root, candidate), 'PLAN_ROOT_OUTSIDE_RUNS', candidate);
    assert.ok(refusal.nextAction.includes(RUNS_DIRECTORY), refusal.nextAction);
    const messageWithoutCandidateEcho = refusal.message.split(`"${candidate}"`).join('');
    assert.ok(!messageWithoutCandidateEcho.includes(root), refusal.message);
    assert.ok(!messageWithoutCandidateEcho.includes(join(root, '.agents', 'runs')), refusal.message);
    assert.ok(refusal.message.includes(`"${RUNS_DIRECTORY}"`), refusal.message);
  }
});

test('formatRuntimePathError tokenizes the project root and keeps the code and next action', async (t) => {
  const root = resolveValidatedProjectRoot(await createTemporaryRoot(t));
  const missing = join(root, 'missing-checkout');
  const refusal = expectRuntimePathError(() => resolveValidatedProjectRoot(missing), 'ROOT_MISSING', missing);
  assert.ok(refusal.message.includes(root));
  const formatted = formatRuntimePathError(refusal, root);
  assert.equal(formatted.code, 'ROOT_MISSING');
  assert.equal(formatted.nextAction, refusal.nextAction);
  assert.ok(formatted.error.includes('<PROJECT_ROOT>'), formatted.error);
  assert.ok(!formatted.error.includes(root), formatted.error);
  assert.ok(!formatted.error.includes(tmpdir()), formatted.error);
  assert.deepEqual(Object.keys(formatted), ['error', 'code', 'nextAction']);
});

test('formatRuntimePathError tokenizes the temp directory when no root is given', async (t) => {
  const root = await createTemporaryRoot(t, false);
  const refusal = expectRuntimePathError(() => resolveValidatedProjectRoot(root), 'ROOT_NOT_ADW', '.agents');
  const formatted = formatRuntimePathError(refusal);
  assert.ok(!formatted.error.includes(tmpdir()), formatted.error);
  assert.ok(!formatted.error.includes(root), formatted.error);
});

test('registry output directories round-trip as forward-slash relative paths', async (t) => {
  const root = resolveValidatedProjectRoot(await createTemporaryRoot(t));
  const absoluteDir = resolve(root, RUNS_DIRECTORY, 'r521-gbp-reviews-insights-exports');
  const stored = toRegistryOutputDir(root, absoluteDir);
  assert.equal(stored, `${RUNS_DIRECTORY}/r521-gbp-reviews-insights-exports`);
  assert.ok(!stored.includes('\\'));
  assert.equal(fromRegistryOutputDir(root, stored), absoluteDir);
  assert.equal(fromRegistryOutputDir(root, absoluteDir), absoluteDir);
  assert.equal(fromRegistryOutputDir(root, `${RUNS_DIRECTORY}/x/./y/../z`), [root, '.agents', 'runs', 'x', 'z'].join(sep));
});

test('isRuntimePathError distinguishes runtime path errors from other errors', () => {
  const runtimePathError = new RuntimePathError('ROOT_MISSING', 'project root "x" is not an existing directory', 'pass an existing checkout');
  assert.equal(isRuntimePathError(runtimePathError), true);
  assert.equal(runtimePathError.name, 'RuntimePathError');
  assert.equal(isRuntimePathError(new Error('x')), false);
  assert.equal(isRuntimePathError(undefined), false);
});
