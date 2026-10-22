#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { assertPlanSlug, formatRuntimePathError, isRuntimePathError, resolveValidatedProjectRoot } from './runtime-paths';

const DEFAULT_DB_RELATIVE_PATH = join('.agents', 'data', 'tasks.db');

const VALID_LAYERS   = new Set(['schema','service','route','component','hook','test','test-assess','live','audit','config','infra','contract','agent']);
const VALID_STATUSES = new Set(['pending','in_progress','completed','needs_revision']);
const VALID_REVIEW   = new Set(['pending_review','approved','changes_requested']);
const VALID_CALLERS  = new Set(['planner','builder-product','validator-product','code-simplifier','silent-failure-hunter','log-auditor','ui-tester','test-creator','builder','validator','reviewer','tester','scenario-writer','test-resolver','live-runner']);
const FE_OPS         = new Set(['create','modify','delete']);
const VALID_TASK_KINDS = new Set(['artifact','work','review','triage','supervisor','orchestration']);
const DISCOVERED_KEYS = ['driftFromTDD','filesCreated','filesModified','decisionsNotInTDD'];
const SELF_AUDIT_KEYS = ['assumptions','shortcuts','patternAlignment'];
const DEFAULT_STALE_SECONDS = 900;

const STOP_WORDS = new Set([
  'the','a','an','is','it','in','on','at','to','for','of','and','or',
  'how','what','when','where','why','should','do','i','we','you','about',
  'this','that','with','from','use','can','which','are','was','be','has',
  'have','had','not','but','by','as','if','so','any','all','get','set',
  'task','tasks','plan','plans',
]);

interface TaskRow {
  id: number; plan_id: number; task_id: string; subject: string; description: string;
  active_form: string; status: string; assigned_to: string; layer: string; codebase: string;
  template: string; parallel: number; depends_on: string; blocked_by: string;
  required_reads: string; files_expected: string; notes: string | null;
  review_status: string | null; review_notes: string | null; discovered_context: string | null;
  self_audit: string | null; files_read: string; file_mutations: string;
  task_kind: string; parent_task_id: string | null; spawned_by: string | null; claimed_by: string | null;
  attempt_count: number; started_at: string | null; heartbeat_at: string | null; last_error: string | null; completed_at: string | null;
  created_at: string; updated_at: string;
}
interface PlanRow  { id: number; name: string; project_dir: string; created_at: string; }
interface EventRow { id: number; plan_id: number; task_id: string; event_type: string; data: string; created_at: string; }

let validatedProjectRoot: string | undefined;

function projectRoot(): string {
  validatedProjectRoot ??= resolveValidatedProjectRoot();
  return validatedProjectRoot;
}

function dbPath(): string {
  return process.env.CODEX_TASK_DB || join(projectRoot(), DEFAULT_DB_RELATIVE_PATH);
}

function j(v: unknown): string { return JSON.stringify(v ?? []); }
function p<T>(s: string | null, fb: T): T {
  if (!s) return fb;
  try { return JSON.parse(s) as T; } catch { return fb; }
}

function open(): Database.Database {
  mkdirSync(dirname(dbPath()), { recursive: true });
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS plans (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(name, project_dir)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id            INTEGER NOT NULL REFERENCES plans(id),
      task_id            TEXT NOT NULL,
      subject            TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      active_form        TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'pending',
      assigned_to        TEXT NOT NULL DEFAULT '',
      layer              TEXT NOT NULL DEFAULT '',
      codebase           TEXT NOT NULL DEFAULT '',
      template           TEXT NOT NULL DEFAULT '',
      parallel           INTEGER NOT NULL DEFAULT 0,
      depends_on         TEXT NOT NULL DEFAULT '[]',
      blocked_by         TEXT NOT NULL DEFAULT '[]',
      required_reads     TEXT NOT NULL DEFAULT '[]',
      files_expected     TEXT NOT NULL DEFAULT '[]',
      notes              TEXT,
      review_status      TEXT,
      review_notes       TEXT,
      discovered_context TEXT,
      self_audit         TEXT,
      files_read         TEXT NOT NULL DEFAULT '[]',
      file_mutations     TEXT NOT NULL DEFAULT '[]',
      task_kind          TEXT NOT NULL DEFAULT 'work',
      parent_task_id     TEXT,
      spawned_by         TEXT,
      claimed_by         TEXT,
      attempt_count      INTEGER NOT NULL DEFAULT 0,
      started_at         TEXT,
      heartbeat_at       TEXT,
      last_error         TEXT,
      completed_at       TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now')),
      UNIQUE(plan_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    INTEGER NOT NULL,
      task_id    TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const meta = db.prepare("SELECT value FROM _meta WHERE key='fts_version'").get() as { value: string } | undefined;
  if (meta?.value !== '2') {
    db.exec(`DROP TABLE IF EXISTS tasks_fts`);
    db.exec(`CREATE VIRTUAL TABLE tasks_fts USING fts5(subject, description)`);
    db.prepare("INSERT OR REPLACE INTO _meta VALUES ('fts_version', '2')").run();
  }

  db.exec(`
    DROP TRIGGER IF EXISTS tasks_ai;
    DROP TRIGGER IF EXISTS tasks_ad;
    DROP TRIGGER IF EXISTS tasks_au;
  `);

  const { count: main } = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
  const { count: fts }  = db.prepare('SELECT COUNT(*) as count FROM tasks_fts').get() as { count: number };
  if (main > 0 && fts === 0) {
    const rows = db.prepare('SELECT id, subject, description FROM tasks').all() as TaskRow[];
    const ins = db.prepare('INSERT INTO tasks_fts(rowid, subject, description) VALUES (?, ?, ?)');
    db.transaction(() => { for (const r of rows) ins.run(r.id, r.subject, r.description); })();
  }

  ensureTaskColumns(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(plan_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(plan_id, task_kind);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(plan_id, parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat ON tasks(plan_id, heartbeat_at);
  `);

  return db;
}

function ensureTaskColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name)
  );
  const additions: Array<[string, string]> = [
    ['task_kind', `ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'work'`],
    ['parent_task_id', `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`],
    ['spawned_by', `ALTER TABLE tasks ADD COLUMN spawned_by TEXT`],
    ['claimed_by', `ALTER TABLE tasks ADD COLUMN claimed_by TEXT`],
    ['attempt_count', `ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`],
    ['started_at', `ALTER TABLE tasks ADD COLUMN started_at TEXT`],
    ['heartbeat_at', `ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT`],
    ['last_error', `ALTER TABLE tasks ADD COLUMN last_error TEXT`],
    ['completed_at', `ALTER TABLE tasks ADD COLUMN completed_at TEXT`],
  ];
  for (const [name, statement] of additions) {
    if (!columns.has(name)) db.exec(statement);
  }
}

function normalizeTaskPath(path: string, root = projectRoot()): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function normalizePathList(paths: string[], root = projectRoot()): Set<string> {
  return new Set(paths.map(path => normalizeTaskPath(path, root)));
}

function appendStringValue(raw: string, value: string): string {
  const current = p(raw, []) as string[];
  if (!current.includes(value)) current.push(value);
  return j(current);
}

function appendTaskPathValue(
  db: Database.Database,
  planId: number,
  taskId: string,
  column: 'files_read' | 'file_mutations',
  value: string,
  timestamp = nowIso(),
): TaskRow {
  const transaction = db.transaction(() => {
    const current = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(planId, taskId) as TaskRow | undefined;
    if (!current) throw new Error(`Task '${taskId}' not found`);
    const nextValue = appendStringValue(column === 'files_read' ? current.files_read : current.file_mutations, value);
    db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(nextValue, timestamp, planId, taskId);
    return db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(planId, taskId) as TaskRow;
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return transaction();
    } catch (error) {
      const isBusy = error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY';
      if (!isBusy || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }

  throw new Error(`Failed to append ${column} for task '${taskId}'`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function stalenessReference(row: TaskRow): string | null {
  return row.heartbeat_at || row.started_at || null;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function taskIsStale(row: TaskRow, olderThanSeconds: number): boolean {
  if (row.status !== 'in_progress') return false;
  const timestamp = parseIso(stalenessReference(row));
  if (timestamp === null) return false;
  return Date.now() - timestamp > olderThanSeconds * 1000;
}

function validateTaskReadyForCompletion(row: TaskRow, root = projectRoot()): string[] {
  const failures: string[] = [];
  const requiredReads = p(row.required_reads, []) as string[];
  const filesExpected = p(row.files_expected, []) as {
    path: string;
    op: string;
    symbolsRequired?: string[];
    symbolsForbidden?: string[];
  }[];
  const filesRead = normalizePathList(p(row.files_read, []) as string[], root);
  const fileMutations = normalizePathList(p(row.file_mutations, []) as string[], root);

  for (const requiredRead of requiredReads) {
    const normalized = normalizeTaskPath(requiredRead, root);
    if (!filesRead.has(normalized)) failures.push(`required read missing: ${requiredRead}`);
  }

  for (const expected of filesExpected) {
    const normalized = normalizeTaskPath(expected.path, root);
    const exists = existsSync(normalized);

    if (expected.op === 'create' && !exists) failures.push(`expected created file does not exist: ${expected.path}`);
    if (expected.op === 'modify') {
      if (!exists) failures.push(`expected modified file does not exist: ${expected.path}`);
      if (!fileMutations.has(normalized)) failures.push(`expected modified file was not logged as mutated: ${expected.path}`);
    }
    if (expected.op === 'delete' && exists) failures.push(`expected deleted file still exists: ${expected.path}`);

    if (!exists || expected.op === 'delete') continue;

    let content = '';
    try { content = readFileSync(normalized, 'utf8'); }
    catch (error) {
      failures.push(`could not read expected file for symbol checks: ${expected.path}`);
      continue;
    }

    for (const symbol of expected.symbolsRequired ?? []) {
      if (!content.includes(symbol)) failures.push(`required symbol missing in ${expected.path}: ${symbol}`);
    }
    for (const symbol of expected.symbolsForbidden ?? []) {
      if (content.includes(symbol)) failures.push(`forbidden symbol present in ${expected.path}: ${symbol}`);
    }
  }

  if (!row.discovered_context) failures.push('discoveredContext is required for completion');
  if (!row.self_audit) failures.push('selfAudit is required for completion');

  return failures;
}

function getOrCreatePlan(db: Database.Database, name: string, dir: string): PlanRow {
  db.prepare(`INSERT OR IGNORE INTO plans (name, project_dir) VALUES (?, ?)`).run(name, dir);
  return db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(name, dir) as PlanRow;
}

function getPlan(db: Database.Database, name: string, dir: string): PlanRow | undefined {
  return db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(name, dir) as PlanRow | undefined;
}

function getTask(db: Database.Database, planId: number, taskId: string): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(planId, taskId) as TaskRow | undefined;
}

function logEvent(db: Database.Database, planId: number, taskId: string, type: string, data: object) {
  db.prepare(`INSERT INTO task_events (plan_id, task_id, event_type, data) VALUES (?, ?, ?, ?)`)
    .run(planId, taskId, type, JSON.stringify(data));
}

function loadPlanRows(db: Database.Database, planId: number): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE plan_id = ? ORDER BY id ASC`).all(planId) as TaskRow[];
}

function runnableRows(rows: TaskRow[]): TaskRow[] {
  const completed = new Set(rows.filter((row) => row.status === 'completed').map((row) => row.task_id));
  return rows
    .filter((row) => row.status === 'pending')
    .filter((row) => (p(row.blocked_by, []) as string[]).every((dependency) => completed.has(dependency)));
}

function buildPlanSummary(plan: PlanRow, rows: TaskRow[], olderThanSeconds = DEFAULT_STALE_SECONDS): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byKind[row.task_kind] = (byKind[row.task_kind] ?? 0) + 1;
  }
  const runnable = runnableRows(rows);
  const stale = rows.filter((row) => taskIsStale(row, olderThanSeconds));
  return {
    success: true,
    plan: plan.name,
    projectDir: plan.project_dir,
    counts: {
      total: rows.length,
      byStatus,
      byKind,
      runnable: runnable.length,
      stale: stale.length,
    },
    runnableTaskIds: runnable.map((row) => row.task_id),
    inProgressTaskIds: rows.filter((row) => row.status === 'in_progress').map((row) => row.task_id),
    needsRevisionTaskIds: rows.filter((row) => row.status === 'needs_revision').map((row) => row.task_id),
    staleTaskIds: stale.map((row) => row.task_id),
    tasks: rows.map(taskToDict),
  };
}

function taskToDict(row: TaskRow): Record<string, unknown> {
  return {
    taskId: row.task_id, subject: row.subject, description: row.description,
    activeForm: row.active_form, status: row.status, assignedTo: row.assigned_to,
    layer: row.layer, codebase: row.codebase, template: row.template,
    taskKind: row.task_kind, parentTaskId: row.parent_task_id, spawnedBy: row.spawned_by, claimedBy: row.claimed_by,
    attemptCount: row.attempt_count, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, lastError: row.last_error, completedAt: row.completed_at,
    parallel: Boolean(row.parallel),
    dependsOn: p(row.depends_on, []), blockedBy: p(row.blocked_by, []),
    requiredReads: p(row.required_reads, []), filesExpected: p(row.files_expected, []),
    ...(row.notes         !== null ? { notes:             row.notes }                      : {}),
    ...(row.review_status !== null ? { reviewStatus:      row.review_status }              : {}),
    ...(row.review_notes  !== null ? { reviewNotes:       row.review_notes }               : {}),
    ...(row.discovered_context     ? { discoveredContext: p(row.discovered_context, null) } : {}),
    ...(row.self_audit             ? { selfAudit:         p(row.self_audit, null) }         : {}),
    filesRead: p(row.files_read, []), fileMutations: p(row.file_mutations, []),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function syncCache(db: Database.Database, planId: number, planName: string, root: string) {
  const rows = db.prepare(`SELECT * FROM tasks WHERE plan_id = ?`).all(planId) as TaskRow[];
  const dict: Record<string, unknown> = {};
  for (const r of rows) dict[r.task_id] = taskToDict(r);
  const dir = join(root, '.agents', 'runs', planName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task-list.json'), JSON.stringify(dict, null, 2));
}

function validateFilesExpected(raw: unknown[]): object[] {
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (!e.path || typeof e.path !== 'string') throw new Error(`filesExpected[${i}].path required`);
    if (!FE_OPS.has(e.op as string)) throw new Error(`filesExpected[${i}].op must be create|modify|delete`);
    return {
      path: e.path, op: e.op, required: e.required !== false,
      symbolsRequired: (e.symbolsRequired as string[]) ?? [],
      symbolsForbidden: (e.symbolsForbidden as string[]) ?? [],
    };
  });
}

function out(data: unknown) { console.log(JSON.stringify(data, null, 2)); }
function err(data: unknown): never { console.error(JSON.stringify(data, null, 2)); process.exit(1); }

function readCompletionJson(inlineJson: string | undefined, filePath: string | undefined, optionName: string): object {
  if ((inlineJson === undefined) === (filePath === undefined)) err({ error: `pass exactly one of --${optionName} or --${optionName}-file` });
  if (inlineJson !== undefined) {
    try { return JSON.parse(inlineJson); }
    catch (e) { err({ error: `--${optionName} not valid JSON: ${(e as Error).message}` }); }
  }
  const resolvedFilePath = resolve(filePath as string);
  if (!existsSync(resolvedFilePath)) err({ error: `--${optionName}-file not found: ${filePath}` });
  let completionFileText = '';
  try { completionFileText = readFileSync(resolvedFilePath, 'utf8'); }
  catch (e) { err({ error: `--${optionName}-file not readable: ${filePath}: ${(e as Error).message}` }); }
  try { return JSON.parse(completionFileText); }
  catch (e) { err({ error: `--${optionName}-file not valid JSON: ${filePath}: ${(e as Error).message}` }); }
}

const program = new Command();

program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    projectRoot();
    const plan = actionCommand.opts().plan as string | undefined;
    if (plan !== undefined) assertPlanSlug(plan, '--plan');
  } catch (error) {
    if (!isRuntimePathError(error)) throw error;
    err(formatRuntimePathError(error));
  }
});

program
  .command('create')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--subject <s>')
  .option('--description <d>', '', '')
  .option('--active-form <f>', '', '')
  .option('--assigned-to <a>', '', '')
  .option('--layer <l>', '')
  .option('--codebase <c>', '', '')
  .option('--template <t>', '', '')
  .option('--parallel', '', false)
  .option('--depends-on <id...>')
  .option('--required-reads <path...>')
  .option('--files-expected <json...>')
  .option('--task-kind <kind>', 'artifact|work|review|triage|supervisor|orchestration', 'work')
  .option('--parent-task-id <id>')
  .option('--spawned-by <id>')
  .action((opts) => {
    if (opts.layer && !VALID_LAYERS.has(opts.layer)) {
      err({ error: `Invalid layer '${opts.layer}'. Valid: ${[...VALID_LAYERS].sort().join(', ')}` }); return;
    }
    if (opts.taskKind && !VALID_TASK_KINDS.has(opts.taskKind)) {
      err({ error: `Invalid task-kind '${opts.taskKind}'. Valid: ${[...VALID_TASK_KINDS].sort().join(', ')}` }); return;
    }
    let filesExpected: object[] = [];
    if (opts.filesExpected?.length) {
      try { filesExpected = validateFilesExpected(opts.filesExpected.map((s: string) => JSON.parse(s))); }
      catch (e) { err({ error: (e as Error).message }); return; }
    }
    const db   = open();
    const root = projectRoot();
    const plan = getOrCreatePlan(db, opts.plan, root);
    const exists = db.prepare(`SELECT id FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId);
    if (exists) { err({ error: `Task ${opts.taskId} already exists in plan ${opts.plan}` }); return; }
    const deps = opts.dependsOn ?? [];
    db.prepare(`
      INSERT INTO tasks (plan_id,task_id,subject,description,active_form,assigned_to,layer,codebase,
        template,parallel,depends_on,blocked_by,required_reads,files_expected,task_kind,parent_task_id,spawned_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(plan.id, opts.taskId, opts.subject, opts.description,
      opts.activeForm || opts.subject, opts.assignedTo ?? '', opts.layer ?? '',
      opts.codebase ?? '', opts.template ?? '', opts.parallel ? 1 : 0,
      j(deps), j(deps), j(opts.requiredReads ?? []), j(filesExpected),
      opts.taskKind, opts.parentTaskId ?? null, opts.spawnedBy ?? null);
    const row = getTask(db, plan.id, opts.taskId) as TaskRow;
    db.prepare(`INSERT INTO tasks_fts(rowid, subject, description) VALUES (?, ?, ?)`).run(row.id, row.subject, row.description);
    logEvent(db, plan.id, opts.taskId, 'task_created', taskToDict(row));
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(row) });
  });

program
  .command('get')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .action((opts) => {
    const db   = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const row  = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow | undefined;
    if (!row)  { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }

    const filesExpected = p(row.files_expected, []) as object[];
    const requiredReads = p(row.required_reads, []) as string[];
    const dependsOn     = p(row.depends_on, []) as string[];
    const result: Record<string, unknown> = { success: true, taskId: row.task_id };

    if (filesExpected.length) {
      result.CONTRACT = {
        headline: 'SCRIPT-ENFORCED EXECUTION CONTRACT — tasks.ts complete will fail if any entry is unsatisfied.',
        filesExpected,
        rules: [
          'op=create → file MUST exist on disk when you mark completed.',
          'op=modify → file MUST exist AND you MUST log it with tasks.ts log-mutation before completion.',
          'op=delete → file MUST NOT exist on disk when you mark completed.',
          'symbolsRequired → each listed symbol MUST appear in the final file.',
          'symbolsForbidden → none of the listed symbols may appear in the final file.',
        ],
        ifBlocked: 'Read the tasks.ts complete JSON error. Fix each reason. Re-run tasks.ts complete.',
      };
    }

    result.AGENT_PREAMBLE = (
      'You have received your task. This is the context you BEGIN with — not all context required. ' +
      'Read codebase files, discover TDD drift, notice patterns the planner missed. ' +
      'At completion provide: (1) --discovered-context: driftFromTDD, filesCreated, filesModified, decisionsNotInTDD. ' +
      "(2) --self-audit: assumptions, shortcuts, patternAlignment. Use 'none' only if genuinely nothing to report."
    );
    result.task = taskToDict(row);

    if (requiredReads.length) {
      result.REQUIRED_READS = requiredReads;
      result.REQUIRED_READS_NOTE = 'You MUST read these files before writing any code and log each read with tasks.ts log-read. tasks.ts complete fails until all are logged.';
    }
    if (row.layer) {
      result.LAYER_NOTE = `Planner assessed layer '${row.layer}'. Verify against actual files you touch. Known layers: ${[...VALID_LAYERS].sort().join(', ')}`;
    }

    if (dependsOn.length) {
      const upstream: object[] = [];
      for (const depId of dependsOn) {
        const dep = db.prepare(`SELECT discovered_context FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, depId) as { discovered_context: string | null } | undefined;
        const dc  = p(dep?.discovered_context ?? null, null) as Record<string, unknown> | null;
        if (dc) upstream.push({ fromTask: depId, driftFromTDD: dc.driftFromTDD ?? [], filesCreated: dc.filesCreated ?? [], decisionsNotInTDD: dc.decisionsNotInTDD ?? [] });
      }
      if (upstream.length) {
        result.UPSTREAM_CONTEXT = upstream;
        result.UPSTREAM_NOTE = 'Upstream tasks left discoveredContext. Read it — TDD drift, created files, or decisions affect your work.';
      }
    }

    out(result);
  });

program
  .command('list')
  .requiredOption('--plan <p>')
  .option('--status <s>')
  .option('--owner <o>')
  .action((opts) => {
    const db   = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { out({ success: true, count: 0, tasks: [] }); return; }
    let q = `SELECT * FROM tasks WHERE plan_id = ?`;
    const params: unknown[] = [plan.id];
    if (opts.status) { q += ` AND status = ?`;      params.push(opts.status); }
    if (opts.owner)  { q += ` AND assigned_to = ?`; params.push(opts.owner); }
    q += ` ORDER BY id ASC`;
    const rows = db.prepare(q).all(...params) as TaskRow[];
    out({ success: true, count: rows.length, tasks: rows.map(taskToDict) });
  });

program
  .command('update')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .option('--status <s>')
  .option('--owner <o>')
  .option('--add-blocked-by <id...>')
  .option('--remove-blocked-by <id...>')
  .option('--notes <n>')
  .option('--review-status <s>')
  .option('--review-notes <n>')
  .option('--description <d>')
  .option('--subject <s>')
  .option('--active-form <f>')
  .option('--caller <c>')
  .option('--discovered-context <json>')
  .option('--self-audit <json>')
  .option('--files-expected <json...>')
  .option('--codebase <c>')
  .option('--files-read <json>')
  .option('--file-mutations <json>')
  .option('--task-kind <kind>')
  .option('--parent-task-id <id>')
  .option('--spawned-by <id>')
  .option('--claimed-by <id>')
  .option('--last-error <message>')
  .action((opts) => {
    const db   = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const row  = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow | undefined;
    if (!row)  { err({ error: `Task '${opts.taskId}' not found` }); return; }

    const plannerFieldUsed = opts.description !== undefined || opts.subject !== undefined
      || opts.activeForm !== undefined || opts.filesExpected !== undefined || opts.codebase !== undefined
      || opts.taskKind !== undefined || opts.parentTaskId !== undefined || opts.spawnedBy !== undefined;
    if (plannerFieldUsed && opts.caller !== 'planner') {
      err({ error: 'Only --caller planner can update description, subject, active_form, files_expected, codebase, task-kind, parent-task-id, or spawned-by.' }); return;
    }
    if (opts.status       && !VALID_STATUSES.has(opts.status))      { err({ error: `Invalid status '${opts.status}'` }); return; }
    if (opts.status === 'completed') {
      err({ error: 'Use tasks.ts complete to mark tasks completed. update --status completed bypasses completion validation and is blocked.' }); return;
    }
    if (opts.status === 'in_progress') {
      err({ error: 'Use tasks.ts start to mark tasks in progress. update --status in_progress is blocked so task start events stay consistent.' }); return;
    }
    if (opts.reviewStatus && !VALID_REVIEW.has(opts.reviewStatus))   { err({ error: `Invalid review-status` }); return; }
    if (opts.caller       && !VALID_CALLERS.has(opts.caller))        { err({ error: `Invalid caller '${opts.caller}'` }); return; }
    if (opts.taskKind     && !VALID_TASK_KINDS.has(opts.taskKind))   { err({ error: `Invalid task-kind '${opts.taskKind}'` }); return; }
    if (opts.filesRead || opts.fileMutations) {
      err({ error: 'Use tasks.ts log-read and tasks.ts log-mutation. Direct update of files-read/file-mutations is blocked.' }); return;
    }

    let discoveredContext: object | null = null;
    if (opts.discoveredContext) {
      try { discoveredContext = JSON.parse(opts.discoveredContext); }
      catch (e) { err({ error: `--discovered-context not valid JSON: ${(e as Error).message}` }); return; }
      const missing = DISCOVERED_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(discoveredContext, k));
      if (missing.length) { err({ error: `discoveredContext missing: ${missing.join(', ')}` }); return; }
    }

    let selfAudit: object | null = null;
    if (opts.selfAudit) {
      try { selfAudit = JSON.parse(opts.selfAudit); }
      catch (e) { err({ error: `--self-audit not valid JSON: ${(e as Error).message}` }); return; }
      const missing = SELF_AUDIT_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(selfAudit, k));
      if (missing.length) { err({ error: `selfAudit missing: ${missing.join(', ')}` }); return; }
      for (const k of SELF_AUDIT_KEYS) {
        if (typeof (selfAudit as Record<string, unknown>)[k] !== 'string') {
          err({ error: `selfAudit.${k} must be a string` }); return;
        }
      }
    }

    const updates: Record<string, unknown> = {};
    if (opts.status)       updates.status        = opts.status;
    if (opts.owner)        updates.assigned_to   = opts.owner;
    if (opts.notes)        updates.notes         = opts.notes;
    if (opts.reviewStatus) updates.review_status = opts.reviewStatus;
    if (opts.reviewNotes)  updates.review_notes  = opts.reviewNotes;
    if (opts.description)  updates.description   = opts.description;
    if (opts.subject)      updates.subject       = opts.subject;
    if (opts.activeForm)   updates.active_form   = opts.activeForm;
    if (opts.codebase !== undefined) updates.codebase = opts.codebase;
    if (opts.taskKind !== undefined) updates.task_kind = opts.taskKind;
    if (opts.parentTaskId !== undefined) updates.parent_task_id = opts.parentTaskId || null;
    if (opts.spawnedBy !== undefined) updates.spawned_by = opts.spawnedBy || null;
    if (opts.claimedBy !== undefined) updates.claimed_by = opts.claimedBy || null;
    if (opts.lastError !== undefined) updates.last_error = opts.lastError || null;
    if (discoveredContext) updates.discovered_context = j(discoveredContext);
    if (selfAudit)         updates.self_audit         = j(selfAudit);

    if (opts.filesExpected !== undefined) {
      try { updates.files_expected = j(validateFilesExpected(opts.filesExpected.map((s: string) => JSON.parse(s)))); }
      catch (e) { err({ error: (e as Error).message }); return; }
    }
    if (opts.filesRead) {
      try { updates.files_read = j(JSON.parse(opts.filesRead)); }
      catch (e) { err({ error: `--files-read not valid JSON` }); return; }
    }
    if (opts.fileMutations) {
      try { updates.file_mutations = j(JSON.parse(opts.fileMutations)); }
      catch (e) { err({ error: `--file-mutations not valid JSON` }); return; }
    }

    if (opts.addBlockedBy?.length) {
      const cur = p(row.blocked_by, []) as string[];
      for (const id of opts.addBlockedBy) if (!cur.includes(id)) cur.push(id);
      updates.blocked_by = j(cur);
    }
    if (opts.removeBlockedBy?.length) {
      const cur = p(row.blocked_by, []) as string[];
      updates.blocked_by = j(cur.filter((id: string) => !(opts.removeBlockedBy as string[]).includes(id)));
    }

    if (!Object.keys(updates).length) { out({ success: true, taskId: opts.taskId, task: taskToDict(row) }); return; }
    updates.updated_at = new Date().toISOString();

    const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${cols} WHERE plan_id = ? AND task_id = ?`)
      .run(...Object.values(updates), plan.id, opts.taskId);

    const updated = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow;
    if (updates.subject !== undefined || updates.description !== undefined) {
      db.prepare(`DELETE FROM tasks_fts WHERE rowid = ?`).run(row.id);
      db.prepare(`INSERT INTO tasks_fts(rowid, subject, description) VALUES (?, ?, ?)`).run(row.id, updated.subject, updated.description);
    }
    logEvent(db, plan.id, opts.taskId, 'task_updated', { ...updates, caller: opts.caller });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(updated) });
  });

program
  .command('start')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .option('--caller <c>', '', 'builder')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    if (!VALID_CALLERS.has(opts.caller)) { err({ error: `Invalid caller '${opts.caller}'` }); return; }
    const row = getTask(db, plan.id, opts.taskId);
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    const timestamp = nowIso();
    db.prepare(`UPDATE tasks SET status = 'in_progress', claimed_by = ?, started_at = COALESCE(started_at, ?), heartbeat_at = ?, last_error = NULL, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(opts.caller, timestamp, timestamp, timestamp, plan.id, opts.taskId);
    const updated = getTask(db, plan.id, opts.taskId) as TaskRow;
    logEvent(db, plan.id, opts.taskId, 'task_started', { caller: opts.caller });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(updated) });
  });

program
  .command('heartbeat')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--caller <c>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    if (!VALID_CALLERS.has(opts.caller)) { err({ error: `Invalid caller '${opts.caller}'` }); return; }
    const row = getTask(db, plan.id, opts.taskId);
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    const timestamp = nowIso();
    db.prepare(`UPDATE tasks SET claimed_by = ?, heartbeat_at = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(opts.caller, timestamp, timestamp, plan.id, opts.taskId);
    const updated = getTask(db, plan.id, opts.taskId) as TaskRow;
    logEvent(db, plan.id, opts.taskId, 'task_heartbeat', { caller: opts.caller });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(updated) });
  });

program
  .command('log-read')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--path <path...>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const row = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow | undefined;
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    const givenPaths = opts.path as string[];
    const normalizedPaths = givenPaths.map(path => normalizeTaskPath(path, root));
    const missingPaths = givenPaths.filter((_, index) => !existsSync(normalizedPaths[index]));
    if (missingPaths.length) { err({ error: 'Cannot log read for missing paths', paths: missingPaths }); return; }
    let updated = row;
    for (const normalized of normalizedPaths) {
      updated = appendTaskPathValue(db, plan.id, opts.taskId, 'files_read', normalized);
      logEvent(db, plan.id, opts.taskId, 'read_logged', { path: normalized });
    }
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, filesRead: p(updated.files_read, []) });
  });

program
  .command('log-mutation')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--path <path...>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const row = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow | undefined;
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    const givenPaths = opts.path as string[];
    const normalizedPaths = givenPaths.map(path => normalizeTaskPath(path, root));
    const expectedPaths = normalizePathList((p(row.files_expected, []) as { path: string }[]).map(entry => entry.path), root);
    const outputRoot = normalizeTaskPath(join('.agents', 'runs', opts.plan, 'agent-outputs'), root);
    const undeclaredPaths = givenPaths.filter((_, index) => !expectedPaths.has(normalizedPaths[index]) && !isPathWithin(normalizedPaths[index], outputRoot));
    if (undeclaredPaths.length) {
      err({
        error: 'Mutation paths are not declared in filesExpected and are not under the plan agent-outputs directory.',
        paths: undeclaredPaths,
      });
      return;
    }
    let updated = row;
    for (const normalized of normalizedPaths) {
      updated = appendTaskPathValue(db, plan.id, opts.taskId, 'file_mutations', normalized);
      logEvent(db, plan.id, opts.taskId, 'mutation_logged', { path: normalized });
    }
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, fileMutations: p(updated.file_mutations, []) });
  });

program
  .command('complete')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--caller <c>')
  .option('--discovered-context <json>')
  .option('--discovered-context-file <file>')
  .option('--self-audit <json>')
  .option('--self-audit-file <file>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const row = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND task_id = ?`).get(plan.id, opts.taskId) as TaskRow | undefined;
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    if (!VALID_CALLERS.has(opts.caller)) { err({ error: `Invalid caller '${opts.caller}'` }); return; }

    const discoveredContext = readCompletionJson(opts.discoveredContext, opts.discoveredContextFile, 'discovered-context');
    const selfAudit = readCompletionJson(opts.selfAudit, opts.selfAuditFile, 'self-audit');

    const missingDiscovered = DISCOVERED_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(discoveredContext, k));
    if (missingDiscovered.length) { err({ error: `discoveredContext missing: ${missingDiscovered.join(', ')}` }); return; }
    const missingSelfAudit = SELF_AUDIT_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(selfAudit, k));
    if (missingSelfAudit.length) { err({ error: `selfAudit missing: ${missingSelfAudit.join(', ')}` }); return; }

    const candidate = {
      ...row,
      discovered_context: j(discoveredContext),
      self_audit: j(selfAudit),
    };
    const failures = validateTaskReadyForCompletion(candidate, root);
    if (failures.length) {
      err({
        error: 'Task completion contract failed',
        taskId: opts.taskId,
        failures,
      });
      return;
    }

    db.prepare(`UPDATE tasks SET status = 'completed', discovered_context = ?, self_audit = ?, heartbeat_at = ?, completed_at = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(j(discoveredContext), j(selfAudit), nowIso(), nowIso(), nowIso(), plan.id, opts.taskId);
    const updated = getTask(db, plan.id, opts.taskId) as TaskRow;
    logEvent(db, plan.id, opts.taskId, 'task_completed', { caller: opts.caller, discoveredContext, selfAudit });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(updated) });
  });

program
  .command('fail')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .requiredOption('--caller <c>')
  .requiredOption('--reason <reason>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    if (!VALID_CALLERS.has(opts.caller)) { err({ error: `Invalid caller '${opts.caller}'` }); return; }
    const row = getTask(db, plan.id, opts.taskId);
    if (!row) { err({ error: `Task '${opts.taskId}' not found in plan '${opts.plan}'` }); return; }
    db.prepare(`UPDATE tasks SET status = 'pending', claimed_by = NULL, attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(opts.reason, nowIso(), plan.id, opts.taskId);
    const updated = getTask(db, plan.id, opts.taskId) as TaskRow;
    logEvent(db, plan.id, opts.taskId, 'task_failed', { caller: opts.caller, reason: opts.reason, attemptCount: updated.attempt_count });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, taskId: opts.taskId, task: taskToDict(updated) });
  });

program
  .command('requeue-stale')
  .requiredOption('--plan <p>')
  .option('--older-than-seconds <n>', '', `${DEFAULT_STALE_SECONDS}`)
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const olderThanSeconds = parseInt(opts.olderThanSeconds, 10) || DEFAULT_STALE_SECONDS;
    const rows = loadPlanRows(db, plan.id);
    const staleRows = rows.filter((row) => taskIsStale(row, olderThanSeconds));
    for (const row of staleRows) {
      db.prepare(`UPDATE tasks SET status = 'pending', claimed_by = NULL, attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
        .run(`requeued after stale heartbeat (${olderThanSeconds}s)`, nowIso(), plan.id, row.task_id);
      logEvent(db, plan.id, row.task_id, 'task_requeued_stale', { olderThanSeconds });
    }
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, plan: opts.plan, olderThanSeconds, requeuedTaskIds: staleRows.map((row) => row.task_id) });
  });

program
  .command('children')
  .requiredOption('--plan <p>')
  .requiredOption('--task-id <id>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const rows = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? AND parent_task_id = ? ORDER BY id ASC`).all(plan.id, opts.taskId) as TaskRow[];
    out({ success: true, plan: opts.plan, parentTaskId: opts.taskId, count: rows.length, tasks: rows.map(taskToDict) });
  });

program
  .command('claim-next')
  .requiredOption('--plan <p>')
  .requiredOption('--caller <c>')
  .option('--kind <kind...>')
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    if (!VALID_CALLERS.has(opts.caller)) { err({ error: `Invalid caller '${opts.caller}'` }); return; }
    const rows = loadPlanRows(db, plan.id);
    const kinds = opts.kind?.length ? new Set((opts.kind as string[]).filter((value) => VALID_TASK_KINDS.has(value))) : null;
    const candidate = runnableRows(rows).find((row) => !kinds || kinds.has(row.task_kind));
    if (!candidate) {
      out({ success: true, plan: opts.plan, claimed: false });
      return;
    }
    const timestamp = nowIso();
    db.prepare(`UPDATE tasks SET status = 'in_progress', claimed_by = ?, started_at = COALESCE(started_at, ?), heartbeat_at = ?, last_error = NULL, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
      .run(opts.caller, timestamp, timestamp, timestamp, plan.id, candidate.task_id);
    const updated = getTask(db, plan.id, candidate.task_id) as TaskRow;
    logEvent(db, plan.id, candidate.task_id, 'task_claimed', { caller: opts.caller });
    syncCache(db, plan.id, opts.plan, root);
    out({ success: true, plan: opts.plan, claimed: true, task: taskToDict(updated) });
  });

program
  .command('summary')
  .requiredOption('--plan <p>')
  .option('--older-than-seconds <n>', '', `${DEFAULT_STALE_SECONDS}`)
  .option('--json', 'Emit JSON summary', true)
  .action((opts) => {
    const db = open();
    const root = projectRoot();
    const plan = getPlan(db, opts.plan, root);
    if (!plan) { err({ error: `Plan '${opts.plan}' not found` }); return; }
    const rows = loadPlanRows(db, plan.id);
    const olderThanSeconds = parseInt(opts.olderThanSeconds, 10) || DEFAULT_STALE_SECONDS;
    out(buildPlanSummary(plan, rows, olderThanSeconds));
  });

program
  .command('notes')
  .requiredOption('--plan <p>')
  .option('--format <f>', 'text | json', 'text')
  .option('--max-chars <n>', '', '300')
  .action((opts) => {
    const db   = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { console.log('No plan found.'); return; }

    const rows = db.prepare(`SELECT * FROM tasks WHERE plan_id = ? ORDER BY id ASC`).all(plan.id) as TaskRow[];
    const max  = parseInt(opts.maxChars) || 0;
    const clip = (s: string) => max > 0 && s.length > max ? s.slice(0, max) + '…' : s;
    const blank = (v: unknown) => !v || v === 'none' || (Array.isArray(v) && !v.length);

    const items = rows.map(r => {
      const sa  = p(r.self_audit, {}) as Record<string, string>;
      const dc  = p(r.discovered_context, {}) as Record<string, unknown>;
      const e: Record<string, unknown> = { taskId: r.task_id };
      if (!blank(sa.shortcuts))    e.shortcuts   = clip(sa.shortcuts);
      if (!blank(sa.assumptions))  e.assumptions = clip(sa.assumptions);
      if (!blank(dc.driftFromTDD)) e.drift       = (dc.driftFromTDD as string[]).map(clip);
      if (!blank(r.notes))         e.notes       = clip(r.notes!);
      return e;
    }).filter(e => e.shortcuts || e.assumptions || e.drift || e.notes);

    if (opts.format === 'json') { console.log(JSON.stringify(items, null, 2)); return; }
    if (!items.length) { console.log(`No debt surfaces in '${opts.plan}'.`); return; }

    const labels: Record<string, string> = {
      shortcuts: 'SHORTCUTS & BANDAIDS', assumptions: 'UNVERIFIED ASSUMPTIONS',
      drift: 'SPEC DRIFT', notes: 'AGENT NOTES',
    };
    for (const item of items) {
      console.log(`\n── ${item.taskId}`);
      for (const field of ['shortcuts','assumptions','drift','notes']) {
        const v = item[field];
        if (!v) continue;
        console.log(`${labels[field]}:`);
        if (Array.isArray(v)) (v as string[]).forEach(l => console.log(`  • ${l}`));
        else console.log(`  ${v}`);
      }
    }
  });

program
  .command('q <query>')
  .description('FTS5 search across all plans')
  .option('--plan <p>', 'scope to one plan')
  .option('--limit <n>', 'max results', '10')
  .action((query: string, opts) => {
    const db   = open();
    const root = projectRoot();

    const terms = [...new Set(
      query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(t => t.length > 2 && !STOP_WORDS.has(t))
    )].slice(0, 6);

    if (!terms.length) { console.log('No meaningful search terms.'); return; }

    let planFilter = '';
    const planParams: unknown[] = [];
    if (opts.plan) {
      const plan = db.prepare(`SELECT id FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
      if (!plan) { console.log(`Plan '${opts.plan}' not found.`); return; }
      planFilter = ` AND t.plan_id = ?`;
      planParams.push(plan.id);
    }

    const stmt = db.prepare(`
      SELECT t.*, p.name as plan_name FROM tasks_fts
      JOIN tasks t ON t.id = tasks_fts.rowid
      JOIN plans p ON p.id = t.plan_id
      WHERE tasks_fts MATCH ?${planFilter}
      ORDER BY rank LIMIT 20
    `);

    const hitCount = new Map<number, number>();
    const rowsById = new Map<number, TaskRow & { plan_name: string }>();
    const matched: string[] = [];

    for (const term of terms) {
      try {
        const hits = stmt.all(term, ...planParams) as (TaskRow & { plan_name: string })[];
        if (hits.length) {
          matched.push(term);
          for (const h of hits) {
            hitCount.set(h.id, (hitCount.get(h.id) ?? 0) + 1);
            rowsById.set(h.id, h);
          }
        }
      } catch { /* FTS5 rejects some terms — skip */ }
    }

    const limit  = parseInt(opts.limit);
    const sorted = [...hitCount.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, limit)
      .map(([id]) => rowsById.get(id)!);

    if (!sorted.length) { console.log(`No tasks found.\nSearched: ${terms.join(', ')}`); return; }

    console.log(`\n## Tasks: ${query}\n`);
    console.log(`Found ${sorted.length} tasks across ${[...new Set(sorted.map(r => r.plan_name))].join(', ')}\n`);
    for (const r of sorted) {
      const hits = hitCount.get(r.id)!;
      console.log(`${r.task_id.padEnd(32)} [${r.status.padEnd(11)}] [${r.plan_name}]  (${hits} term${hits > 1 ? 's' : ''})`);
      console.log(`  ${r.subject}${r.layer ? `  · ${r.layer}` : ''}`);
    }
    console.log(`\nSearched: ${matched.join(', ')} · ${sorted.length}/${rowsById.size} matched`);
  });

program
  .command('timeline')
  .requiredOption('--plan <p>')
  .option('--limit <n>', 'max events', '50')
  .action((opts) => {
    const db   = open();
    const root = projectRoot();
    const plan = db.prepare(`SELECT * FROM plans WHERE name = ? AND project_dir = ?`).get(opts.plan, root) as PlanRow | undefined;
    if (!plan) { console.log(`Plan '${opts.plan}' not found.`); return; }

    const events = db.prepare(`SELECT * FROM task_events WHERE plan_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(plan.id, parseInt(opts.limit)) as EventRow[];

    if (!events.length) { console.log('No events recorded.'); return; }
    console.log(`\n## Timeline: ${opts.plan}\n`);
    for (const e of events) {
      const ts   = e.created_at.slice(0, 19).replace('T', ' ');
      const data = p(e.data, {}) as Record<string, unknown>;
      const note = e.event_type === 'task_created'
        ? `created  ← ${((data.subject as string) ?? '').slice(0, 55)}`
        : `updated  status=${data.status ?? '—'}  caller=${data.caller ?? '—'}`;
      console.log(`${ts}  ${e.task_id.padEnd(32)}  ${note}`);
    }
  });

program
  .command('status')
  .action(() => {
    const db   = open();
    const root = projectRoot();
    const { total }  = db.prepare(`SELECT COUNT(*) as total FROM tasks t JOIN plans p ON p.id = t.plan_id WHERE p.project_dir = ?`).get(root) as { total: number };
    const { active } = db.prepare(`SELECT COUNT(*) as active FROM tasks t JOIN plans p ON p.id = t.plan_id WHERE p.project_dir = ? AND t.status = 'in_progress'`).get(root) as { active: number };
    const { plans }  = db.prepare(`SELECT COUNT(DISTINCT p.id) as plans FROM plans p WHERE p.project_dir = ?`).get(root) as { plans: number };
    const recent = db.prepare(`SELECT t.task_id, t.status, p.name as plan FROM tasks t JOIN plans p ON p.id = t.plan_id WHERE p.project_dir = ? ORDER BY t.updated_at DESC LIMIT 1`).get(root) as { task_id: string; status: string; plan: string } | undefined;
    console.log(`Tasks: ${total} across ${plans} plan${plans !== 1 ? 's' : ''}  ·  ${active} in-progress${recent ? `  ·  last: ${recent.task_id} (${recent.status}) — ${recent.plan}` : ''}`);
  });

program.parse();
