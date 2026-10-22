#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function projectRoot(): string {
  return process.env.CODEX_AGENT_ROOT || process.cwd();
}

const DB_PATH = process.env.CODEX_DEPOSITION_DB || path.join(projectRoot(), '.agents', 'data', 'deposition.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS deposition_sessions (
  session_id TEXT PRIMARY KEY,
  codebase_name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  product_url TEXT NOT NULL,
  category_name TEXT NOT NULL,
  session_path TEXT NOT NULL,
  playbook_path TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS deposition_context (
  context_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  context_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_path TEXT,
  body_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES deposition_sessions(session_id) ON DELETE CASCADE,
  UNIQUE (session_id, context_type, body_hash)
);

CREATE TABLE IF NOT EXISTS codebase_deposition_assignments (
  codebase_name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  assigned_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES deposition_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deposition_sessions_codebase ON deposition_sessions(codebase_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposition_context_session ON deposition_context(session_id, context_type);
`);

const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return undefined;
  return v;
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (!v) {
    fail(`Missing required flag: --${name}`);
  }
  return v;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function ok(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

if (cmd === 'sessions' && sub === 'start') {
  const now = new Date().toISOString();
  const sessionId = id('dep');
  db.prepare(`
    INSERT INTO deposition_sessions
      (session_id, codebase_name, company_name, product_url, category_name, session_path, created_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    requireFlag('codebase'),
    requireFlag('company'),
    requireFlag('product-url'),
    requireFlag('category'),
    requireFlag('session-path'),
    now,
    flag('notes') ?? null,
  );
  ok({ session_id: sessionId, status: 'running', created_at: now });
  process.exit(0);
}

if (cmd === 'sessions' && sub === 'complete') {
  const sessionId = requireFlag('session');
  const playbookPath = requireFlag('playbook');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE deposition_sessions
    SET status = 'complete', completed_at = ?, playbook_path = ?
    WHERE session_id = ?
  `).run(now, playbookPath, sessionId);
  ok({ session_id: sessionId, status: 'complete', completed_at: now, playbook_path: playbookPath });
  process.exit(0);
}

if (cmd === 'context' && sub === 'add') {
  const sessionId = requireFlag('session');
  const contextType = requireFlag('type');
  const title = requireFlag('title');
  const sourcePath = flag('source');
  const body = flag('body') ?? (sourcePath ? fs.readFileSync(sourcePath, 'utf8') : '');
  if (!body.trim()) {
    fail('Context body is required. Pass --body or --source.');
  }

  const now = new Date().toISOString();
  const contextId = id('ctx');
  db.prepare(`
    INSERT OR IGNORE INTO deposition_context
      (context_id, session_id, context_type, title, body, source_path, body_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contextId, sessionId, contextType, title, body, sourcePath ?? null, hash(body), now);
  ok({ context_id: contextId, session_id: sessionId, context_type: contextType, title, created_at: now });
  process.exit(0);
}

if (cmd === 'codebases' && sub === 'assign') {
  const codebase = requireFlag('codebase');
  const sessionId = requireFlag('session');
  const reason = flag('reason') ?? null;
  const session = db.prepare(`
    SELECT session_id, codebase_name, playbook_path, status
    FROM deposition_sessions
    WHERE session_id = ?
  `).get(sessionId) as { session_id: string; codebase_name: string; playbook_path: string | null; status: string } | undefined;
  if (!session) {
    fail(`No deposition session found for ${sessionId}`);
  }
  if (session.codebase_name !== codebase) {
    fail(`Session ${sessionId} belongs to ${session.codebase_name}, not ${codebase}`);
  }
  if (session.status !== 'complete' || !session.playbook_path) {
    fail(`Session ${sessionId} is not complete or has no playbook_path`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO codebase_deposition_assignments
      (codebase_name, session_id, assigned_at, assigned_reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(codebase_name) DO UPDATE SET
      session_id = excluded.session_id,
      assigned_at = excluded.assigned_at,
      assigned_reason = excluded.assigned_reason
  `).run(codebase, sessionId, now, reason);
  ok({ codebase_name: codebase, session_id: sessionId, assigned_at: now, assigned_reason: reason });
  process.exit(0);
}

if (cmd === 'codebases' && sub === 'active') {
  const codebase = requireFlag('codebase');
  const row = db.prepare(`
    SELECT
      a.codebase_name,
      a.assigned_at,
      a.assigned_reason,
      s.session_id,
      s.company_name,
      s.product_url,
      s.category_name,
      s.session_path,
      s.playbook_path,
      s.status,
      s.created_at,
      s.completed_at
    FROM codebase_deposition_assignments a
    JOIN deposition_sessions s ON s.session_id = a.session_id
    WHERE a.codebase_name = ?
  `).get(codebase);
  ok(row ?? { codebase_name: codebase, active: false });
  process.exit(0);
}

if (cmd === 'sessions' && sub === 'list') {
  const limit = Number(flag('limit') ?? '10');
  const codebase = flag('codebase');
  const rows = codebase
    ? db.prepare(`SELECT * FROM deposition_sessions WHERE codebase_name = ? ORDER BY created_at DESC LIMIT ?`).all(codebase, limit)
    : db.prepare(`SELECT * FROM deposition_sessions ORDER BY created_at DESC LIMIT ?`).all(limit);
  ok(rows);
  process.exit(0);
}

if (cmd === 'sessions' && sub === 'status') {
  const sessionId = requireFlag('session');
  const session = db.prepare(`SELECT * FROM deposition_sessions WHERE session_id = ?`).get(sessionId);
  const context = db.prepare(`
    SELECT context_id, context_type, title, source_path, created_at
    FROM deposition_context
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);
  ok({ session, context });
  process.exit(0);
}

fail('Commands: sessions start|complete|list|status, context add, codebases assign|active');
