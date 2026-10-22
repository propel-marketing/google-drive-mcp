import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxEntryPoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const auditDbScript = join(repoRoot, '.agents', 'scripts', 'audit-db.ts');

interface AuditDbCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runAuditDbCli(root: string, args: string[]): AuditDbCliResult {
  const spawned = spawnSync(process.execPath, [tsxEntryPoint, auditDbScript, ...args], {
    cwd: root,
    env: { ...process.env, CODEX_AGENT_ROOT: root },
    encoding: 'utf8',
  });
  return { status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr };
}

async function createHelpRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'adw-audit-db-help-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function assertUsagePrintedWithoutSideEffect(root: string, outcome: AuditDbCliResult, step: string): void {
  assert.equal(outcome.status, 0, `${step} exited ${outcome.status}: ${outcome.stderr}`);
  assert.ok(outcome.stdout.includes('Usage: audit-db.ts'), `${step} stdout lacks the usage line: ${outcome.stdout}`);
  assert.ok(outcome.stdout.includes('Groups:'), `${step} stdout lacks the groups line: ${outcome.stdout}`);
  assert.equal(outcome.stderr, '', `${step} wrote to stderr: ${outcome.stderr}`);
  assert.equal(existsSync(join(root, '.agents')), false, `${step} created an .agents directory under the root`);
}

test('--help prints usage to stdout, exits 0 and opens no database', async (t) => {
  const root = await createHelpRoot(t);
  assertUsagePrintedWithoutSideEffect(root, runAuditDbCli(root, ['--help']), '--help');
});

test('no argument behaves like --help', async (t) => {
  const root = await createHelpRoot(t);
  assertUsagePrintedWithoutSideEffect(root, runAuditDbCli(root, []), 'no argument');
});

test('an unknown group still fails on stderr with exit 1', async (t) => {
  const root = await createHelpRoot(t);
  const outcome = runAuditDbCli(root, ['bogus-group']);
  assert.equal(outcome.status, 1, `bogus-group exited ${outcome.status}: ${outcome.stderr}`);
  assert.ok(outcome.stderr.includes('Unknown group'), `bogus-group stderr lacks Unknown group: ${outcome.stderr}`);
  assert.equal(outcome.stdout, '', `bogus-group wrote to stdout: ${outcome.stdout}`);
});
