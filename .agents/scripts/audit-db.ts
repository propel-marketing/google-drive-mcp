#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

function projectRoot(): string {
  return process.env.CODEX_AGENT_ROOT || process.cwd();
}

const DB_PATH = process.env.CODEX_AUDIT_DB || join(projectRoot(), '.agents', 'data', 'audit.db');

function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initialize(db);
  return db;
}

function initialize(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codebases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      path       TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      codebase_id  INTEGER NOT NULL REFERENCES codebases(id),
      audit_date   TEXT NOT NULL DEFAULT (date('now')),
      status       TEXT NOT NULL DEFAULT 'in_progress',
      output_path  TEXT,
      notes        TEXT,
      git_sha      TEXT,
      feature_name TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audits_codebase_id ON audits(codebase_id);

    CREATE TABLE IF NOT EXISTS findings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id    INTEGER NOT NULL REFERENCES audits(id),
      severity    TEXT NOT NULL,
      category    TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      file_path   TEXT,
      line_number INTEGER,
      status      TEXT NOT NULL DEFAULT 'open',
      feature     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_findings_audit_id ON findings(audit_id);
    CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
    CREATE INDEX IF NOT EXISTS idx_findings_feature ON findings(feature);

    CREATE TABLE IF NOT EXISTS glossary (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      term        TEXT NOT NULL,
      definition  TEXT NOT NULL,
      domain      TEXT,
      codebase_id INTEGER REFERENCES codebases(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(term, codebase_id)
    );
    CREATE INDEX IF NOT EXISTS idx_glossary_codebase_id ON glossary(codebase_id);

    CREATE TABLE IF NOT EXISTS decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      context      TEXT,
      decision     TEXT NOT NULL,
      consequences TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      codebase_id  INTEGER REFERENCES codebases(id),
      decided_at   TEXT NOT NULL DEFAULT (date('now')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_codebase_id ON decisions(codebase_id);

    CREATE TABLE IF NOT EXISTS journal (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id    INTEGER REFERENCES audits(id),
      session_id  TEXT,
      tool        TEXT,
      file_path   TEXT,
      note        TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_audit_id ON journal(audit_id);
    CREATE INDEX IF NOT EXISTS idx_journal_occurred_at ON journal(occurred_at DESC);

    CREATE TABLE IF NOT EXISTS test_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      codebase_id    INTEGER NOT NULL REFERENCES codebases(id),
      run_date       TEXT NOT NULL DEFAULT (date('now')),
      skill          TEXT NOT NULL CHECK(skill IN ('test','test-coverage')),
      status         TEXT NOT NULL CHECK(status IN ('in_progress','complete','failed','aborted')) DEFAULT 'in_progress',
      output_path    TEXT,
      findings_count INTEGER DEFAULT 0,
      report_path    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_test_runs_codebase_id ON test_runs(codebase_id);
    CREATE INDEX IF NOT EXISTS idx_test_runs_run_date ON test_runs(run_date DESC);

    CREATE TABLE IF NOT EXISTS traces (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      codebase_id    INTEGER NOT NULL REFERENCES codebases(id),
      feature_name   TEXT NOT NULL,
      slug           TEXT NOT NULL,
      concept        TEXT NOT NULL,
      status         TEXT NOT NULL CHECK(status IN ('clean','structural','behavioral','operational','compute','declined')),
      dimension      TEXT,
      verified_on    TEXT,
      output_path    TEXT,
      fragment_path  TEXT,
      run_date       TEXT NOT NULL DEFAULT (date('now')),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traces_codebase_id ON traces(codebase_id);
    CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
    CREATE INDEX IF NOT EXISTS idx_traces_run_date ON traces(run_date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_codebase_slug ON traces(codebase_id, slug);
  `);
}

function resolveCodbase(db: Database.Database, idOrName: string): number {
  const byId = db.prepare('SELECT id FROM codebases WHERE id = ?').get(Number(idOrName) || -1) as { id: number } | undefined;
  if (byId) return byId.id;
  const byName = db.prepare('SELECT id FROM codebases WHERE name = ? OR slug = ?').get(idOrName, idOrName) as { id: number } | undefined;
  if (byName) return byName.id;
  console.error(JSON.stringify({ error: `codebase not found: ${idOrName}` }));
  process.exit(1);
}

function printUsage(write: (line: string) => void): void {
  write('Usage: audit-db.ts <group> <action> [flags]');
  write('Groups: init, codebases, audits, findings, glossary, decisions, journal, test-runs, traces');
  write('Help: audit-db.ts --help');
}

const [, , group, action, ...rest] = process.argv;

if (group === undefined || group === '--help' || group === '-h') {
  printUsage(console.log);
  process.exit(0);
}

if (group === 'init') {
  const db = open();
  console.log('audit.db initialized');
  process.exit(0);
}

if (group === 'migrate') {
  const db = open();
  try {
    db.exec(`
      ALTER TABLE audits ADD COLUMN git_sha TEXT;
      ALTER TABLE audits ADD COLUMN feature_name TEXT;
      ALTER TABLE findings ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE findings ADD COLUMN feature TEXT;
      ALTER TABLE glossary ADD COLUMN codebase_id INTEGER REFERENCES codebases(id);
      ALTER TABLE decisions ADD COLUMN codebase_id INTEGER REFERENCES codebases(id);
      CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
      CREATE INDEX IF NOT EXISTS idx_findings_feature ON findings(feature);
      CREATE INDEX IF NOT EXISTS idx_glossary_codebase_id ON glossary(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_codebase_id ON decisions(codebase_id);
    `);
    console.log(JSON.stringify({ migrated: true }));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ migrated: false, reason: message }));
    process.exit(0);
  }
}

if (group === 'codebases') {
  const db = open();

  if (action === 'add') {
    const slug  = rest[rest.indexOf('--slug')  + 1];
    const name  = rest[rest.indexOf('--name')  + 1];
    const path  = rest.includes('--path')  ? rest[rest.indexOf('--path')  + 1] : null;
    const notes = rest.includes('--notes') ? rest[rest.indexOf('--notes') + 1] : null;
    if (!slug || !name) { console.error('--slug and --name required'); process.exit(1); }
    const r = db.prepare('INSERT INTO codebases (slug, name, path, notes) VALUES (?, ?, ?, ?)').run(slug, name, path, notes);
    console.log(JSON.stringify({ id: r.lastInsertRowid, slug, name }));
    process.exit(0);
  }

  if (action === 'list') {
    const rows = db.prepare('SELECT * FROM codebases ORDER BY name').all();
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const idOrName = rest[0];
    const row = db.prepare('SELECT * FROM codebases WHERE id = ? OR slug = ? OR name = ?').get(Number(idOrName) || -1, idOrName, idOrName);
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  console.error(`Unknown codebases action: ${action}`);
  process.exit(1);
}

if (group === 'audits') {
  const db = open();

  if (action === 'start') {
    const codebase    = rest[rest.indexOf('--codebase') + 1];
    const outputPath  = rest.includes('--output-path') ? rest[rest.indexOf('--output-path') + 1] : null;
    const gitSha      = rest.includes('--git-sha')     ? rest[rest.indexOf('--git-sha')     + 1] : null;
    const featureName = rest.includes('--feature')     ? rest[rest.indexOf('--feature')     + 1] : null;
    if (!codebase) { console.error('--codebase required'); process.exit(1); }
    const codebaseId = resolveCodbase(db, codebase);
    const r = db.prepare('INSERT INTO audits (codebase_id, output_path, git_sha, feature_name) VALUES (?, ?, ?, ?)').run(codebaseId, outputPath, gitSha, featureName);
    console.log(JSON.stringify({ audit_id: r.lastInsertRowid }));
    process.exit(0);
  }

  if (action === 'complete') {
    const runId = Number(rest[0]);
    const status = rest.includes('--status') ? rest[rest.indexOf('--status') + 1] : 'complete';
    const notes  = rest.includes('--notes')  ? rest[rest.indexOf('--notes')  + 1] : null;
    db.prepare("UPDATE audits SET status=?, notes=?, updated_at=datetime('now') WHERE id=?").run(status, notes, runId);
    console.log(JSON.stringify({ updated: true, audit_id: runId }));
    process.exit(0);
  }

  if (action === 'list') {
    const codebase = rest[rest.indexOf('--codebase') + 1];
    const limit    = rest.includes('--limit') ? Number(rest[rest.indexOf('--limit') + 1]) : 10;
    if (!codebase) { console.error('--codebase required'); process.exit(1); }
    const codebaseId = resolveCodbase(db, codebase);
    const rows = db.prepare('SELECT * FROM audits WHERE codebase_id=? ORDER BY audit_date DESC LIMIT ?').all(codebaseId, limit);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const row = db.prepare('SELECT * FROM audits WHERE id=?').get(Number(rest[0]));
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  if (action === 'diff') {
    const auditA = Number(rest[0]);
    const auditB = Number(rest[1]);
    if (!auditA || !auditB) { console.error('two audit IDs required as positional arguments'); process.exit(1); }
    const findingsA = db.prepare('SELECT * FROM findings WHERE audit_id=?').all(auditA) as { title: string; severity: string }[];
    const findingsB = db.prepare('SELECT * FROM findings WHERE audit_id=?').all(auditB) as { title: string; severity: string }[];
    const mapA = new Map(findingsA.map(f => [f.title, f]));
    const mapB = new Map(findingsB.map(f => [f.title, f]));
    const added: string[] = [];
    const resolved: string[] = [];
    const severity_changed: { title: string; old: string; new: string }[] = [];
    for (const [title, f] of mapB) {
      if (!mapA.has(title)) { added.push(title); }
      else if (mapA.get(title)!.severity !== f.severity) {
        severity_changed.push({ title, old: mapA.get(title)!.severity, new: f.severity });
      }
    }
    for (const [title] of mapA) {
      if (!mapB.has(title)) { resolved.push(title); }
    }
    console.log(JSON.stringify({ audit_a: auditA, audit_b: auditB, added, resolved, severity_changed }));
    process.exit(0);
  }

  console.error(`Unknown audits action: ${action}`);
  process.exit(1);
}

if (group === 'findings') {
  const db = open();

  if (action === 'add') {
    const auditId   = Number(rest[rest.indexOf('--audit')    + 1]);
    const severity  = rest[rest.indexOf('--severity') + 1];
    const category  = rest[rest.indexOf('--category') + 1];
    const title     = rest[rest.indexOf('--title')    + 1];
    const desc      = rest.includes('--desc') ? rest[rest.indexOf('--desc') + 1] : null;
    const filePath  = rest.includes('--file') ? rest[rest.indexOf('--file') + 1] : null;
    const lineNum   = rest.includes('--line') ? Number(rest[rest.indexOf('--line') + 1]) : null;
    if (!auditId || !severity || !category || !title) {
      console.error('--audit, --severity, --category, --title required');
      process.exit(1);
    }
    const r = db.prepare(
      'INSERT INTO findings (audit_id, severity, category, title, description, file_path, line_number) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(auditId, severity, category, title, desc, filePath, lineNum);
    console.log(JSON.stringify({ finding_id: r.lastInsertRowid }));
    process.exit(0);
  }

  if (action === 'list') {
    const auditFlag    = rest.includes('--audit')    ? rest[rest.indexOf('--audit')    + 1] : null;
    const codebaseFlag = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    const statusFlag   = rest.includes('--status')   ? rest[rest.indexOf('--status')   + 1] : null;
    const severityFlag = rest.includes('--severity') ? rest[rest.indexOf('--severity') + 1] : null;
    const featureFlag  = rest.includes('--feature')  ? rest[rest.indexOf('--feature')  + 1] : null;
    const limitFlag    = rest.includes('--limit')    ? Number(rest[rest.indexOf('--limit') + 1]) : 50;
    if (!auditFlag && !codebaseFlag) { console.error('--audit or --codebase required'); process.exit(1); }
    let q = 'SELECT f.* FROM findings f JOIN audits a ON f.audit_id = a.id JOIN codebases c ON a.codebase_id = c.id WHERE 1=1';
    const params: (number | string)[] = [];
    if (auditFlag)    { q += ' AND f.audit_id=?';  params.push(Number(auditFlag)); }
    if (codebaseFlag) { q += ' AND c.id=?';        params.push(resolveCodbase(db, codebaseFlag)); }
    if (statusFlag)   { q += ' AND f.status=?';    params.push(statusFlag); }
    if (severityFlag) { q += ' AND f.severity=?';  params.push(severityFlag); }
    if (featureFlag)  { q += ' AND f.feature=?';   params.push(featureFlag); }
    q += ' ORDER BY f.severity, f.id LIMIT ?';
    params.push(limitFlag);
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const row = db.prepare('SELECT * FROM findings WHERE id=?').get(Number(rest[0]));
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  if (action === 'update') {
    const findingId   = rest.includes('--finding') ? Number(rest[rest.indexOf('--finding') + 1]) : null;
    const statusVal   = rest.includes('--status')  ? rest[rest.indexOf('--status')  + 1] : null;
    const featureVal  = rest.includes('--feature') ? rest[rest.indexOf('--feature') + 1] : null;
    if (!findingId) { console.error('--finding required'); process.exit(1); }
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (statusVal  !== null) { sets.push('status=?');  params.push(statusVal); }
    if (featureVal !== null) { sets.push('feature=?'); params.push(featureVal); }
    if (sets.length === 0) { console.error('at least one of --status or --feature required'); process.exit(1); }
    params.push(findingId);
    db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id=?`).run(...params);
    const updated = db.prepare('SELECT * FROM findings WHERE id=?').get(findingId);
    console.log(JSON.stringify(updated));
    process.exit(0);
  }

  console.error(`Unknown findings action: ${action}`);
  process.exit(1);
}

if (group === 'glossary') {
  const db = open();

  if (action === 'add') {
    const term     = rest[rest.indexOf('--term')       + 1];
    const def      = rest[rest.indexOf('--definition') + 1];
    const domain   = rest.includes('--domain')   ? rest[rest.indexOf('--domain')   + 1] : null;
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    if (!term || !def) { console.error('--term and --definition required'); process.exit(1); }
    const codebaseId = codebase ? resolveCodbase(db, codebase) : null;
    const r = db.prepare('INSERT OR REPLACE INTO glossary (term, definition, domain, codebase_id) VALUES (?, ?, ?, ?)').run(term, def, domain, codebaseId);
    console.log(JSON.stringify({ glossary_id: r.lastInsertRowid, term }));
    process.exit(0);
  }

  if (action === 'list') {
    const domain   = rest.includes('--domain')   ? rest[rest.indexOf('--domain')   + 1] : null;
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    let q = 'SELECT * FROM glossary WHERE 1=1';
    const params: (string | number)[] = [];
    if (domain)   { q += ' AND domain=?';      params.push(domain); }
    if (codebase) { q += ' AND codebase_id=?'; params.push(resolveCodbase(db, codebase)); }
    q += ' ORDER BY term';
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const row = db.prepare('SELECT * FROM glossary WHERE term=?').get(rest[0]);
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  console.error(`Unknown glossary action: ${action}`);
  process.exit(1);
}

if (group === 'decisions') {
  const db = open();

  if (action === 'record') {
    const title    = rest[rest.indexOf('--title')    + 1];
    const dec      = rest[rest.indexOf('--decision') + 1];
    const ctx      = rest.includes('--context')      ? rest[rest.indexOf('--context')      + 1] : null;
    const cons     = rest.includes('--consequences') ? rest[rest.indexOf('--consequences') + 1] : null;
    const codebase = rest.includes('--codebase')     ? rest[rest.indexOf('--codebase')     + 1] : null;
    if (!title || !dec) { console.error('--title and --decision required'); process.exit(1); }
    const codebaseId = codebase ? resolveCodbase(db, codebase) : null;
    const r = db.prepare(
      'INSERT INTO decisions (title, decision, context, consequences, codebase_id) VALUES (?, ?, ?, ?, ?)'
    ).run(title, dec, ctx, cons, codebaseId);
    console.log(JSON.stringify({ decision_id: r.lastInsertRowid }));
    process.exit(0);
  }

  if (action === 'list') {
    const limit    = rest.includes('--limit')    ? Number(rest[rest.indexOf('--limit')    + 1]) : 20;
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    let q = 'SELECT * FROM decisions WHERE 1=1';
    const params: (number | string)[] = [];
    if (codebase) { q += ' AND codebase_id=?'; params.push(resolveCodbase(db, codebase)); }
    q += ' ORDER BY decided_at DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const row = db.prepare('SELECT * FROM decisions WHERE id=?').get(Number(rest[0]));
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  console.error(`Unknown decisions action: ${action}`);
  process.exit(1);
}

if (group === 'journal') {
  const db = open();

  if (action === 'record') {
    const tool     = rest.includes('--tool')    ? rest[rest.indexOf('--tool')    + 1] : null;
    const filePath = rest.includes('--file')    ? rest[rest.indexOf('--file')    + 1] : null;
    const note     = rest.includes('--note')    ? rest[rest.indexOf('--note')    + 1] : null;
    const auditId  = rest.includes('--audit')   ? Number(rest[rest.indexOf('--audit')   + 1]) : null;
    const session  = rest.includes('--session') ? rest[rest.indexOf('--session') + 1] : null;
    const r = db.prepare(
      'INSERT INTO journal (audit_id, session_id, tool, file_path, note) VALUES (?, ?, ?, ?, ?)'
    ).run(auditId, session, tool, filePath, note);
    console.log(JSON.stringify({ journal_id: r.lastInsertRowid }));
    process.exit(0);
  }

  if (action === 'list') {
    const auditId = rest.includes('--audit') ? Number(rest[rest.indexOf('--audit') + 1]) : null;
    const limit   = rest.includes('--limit') ? Number(rest[rest.indexOf('--limit') + 1]) : 20;
    let q = 'SELECT * FROM journal';
    const params: (number | null)[] = [];
    if (auditId) { q += ' WHERE audit_id=?'; params.push(auditId); }
    q += ' ORDER BY occurred_at DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  console.error(`Unknown journal action: ${action}`);
  process.exit(1);
}

if (group === 'test-runs') {
  const db = open();

  if (action === 'start') {
    const codebase  = rest.includes('--codebase')   ? rest[rest.indexOf('--codebase')   + 1] : null;
    const skill     = rest.includes('--skill')      ? rest[rest.indexOf('--skill')      + 1] : null;
    const outputDir = rest.includes('--output-dir') ? rest[rest.indexOf('--output-dir') + 1] : null;
    if (!codebase || !skill) {
      console.error(JSON.stringify({ error: '--codebase and --skill required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    const r = db.prepare(
      'INSERT INTO test_runs (codebase_id, skill, output_path) VALUES (?, ?, ?)'
    ).run(codebaseId, skill, outputDir);
    console.log(JSON.stringify({ test_run_id: Number(r.lastInsertRowid) }));
    process.exit(0);
  }

  if (action === 'complete') {
    const runId         = Number(rest[0]);
    const status        = rest.includes('--status')         ? rest[rest.indexOf('--status')         + 1] : 'complete';
    const findingsCount = rest.includes('--findings-count') ? Number(rest[rest.indexOf('--findings-count') + 1]) : null;
    const reportPath    = rest.includes('--report-path')    ? rest[rest.indexOf('--report-path')    + 1] : null;
    if (!runId) {
      console.error(JSON.stringify({ error: 'run-id required as first positional argument' }));
      process.exit(1);
    }
    db.prepare(
      "UPDATE test_runs SET status=?, findings_count=COALESCE(?, findings_count), report_path=COALESCE(?, report_path), updated_at=datetime('now') WHERE id=?"
    ).run(status, findingsCount, reportPath, runId);
    console.log(JSON.stringify({ updated: true, test_run_id: runId }));
    process.exit(0);
  }

  if (action === 'list') {
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    const skill    = rest.includes('--skill')    ? rest[rest.indexOf('--skill')    + 1] : null;
    const limit    = rest.includes('--limit')    ? Number(rest[rest.indexOf('--limit')  + 1]) : 10;
    if (!codebase) {
      console.error(JSON.stringify({ error: '--codebase required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    let q = 'SELECT * FROM test_runs WHERE codebase_id=?';
    const params: (number | string)[] = [codebaseId];
    if (skill) { q += ' AND skill=?'; params.push(skill); }
    q += ' ORDER BY run_date DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const runId = Number(rest[0]);
    if (!runId) {
      console.error(JSON.stringify({ error: 'run-id required as first positional argument' }));
      process.exit(1);
    }
    const row = db.prepare('SELECT * FROM test_runs WHERE id=?').get(runId);
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  console.error(JSON.stringify({ error: `Unknown test-runs action: ${action}` }));
  process.exit(1);
}

if (group === 'traces') {
  const db = open();

  if (action === 'log') {
    const codebase     = rest.includes('--codebase')      ? rest[rest.indexOf('--codebase')      + 1] : null;
    const featureName  = rest.includes('--feature')       ? rest[rest.indexOf('--feature')       + 1] : null;
    const slug         = rest.includes('--slug')          ? rest[rest.indexOf('--slug')          + 1] : null;
    const concept      = rest.includes('--concept')       ? rest[rest.indexOf('--concept')       + 1] : null;
    const status       = rest.includes('--status')        ? rest[rest.indexOf('--status')        + 1] : null;
    const dimension    = rest.includes('--dimension')     ? rest[rest.indexOf('--dimension')     + 1] : null;
    const verifiedOn   = rest.includes('--verified-on')   ? rest[rest.indexOf('--verified-on')   + 1] : null;
    const outputPath   = rest.includes('--output-path')   ? rest[rest.indexOf('--output-path')   + 1] : null;
    const fragmentPath = rest.includes('--fragment-path') ? rest[rest.indexOf('--fragment-path') + 1] : null;
    if (!codebase || !featureName || !slug || !concept || !status) {
      console.error(JSON.stringify({ error: '--codebase, --feature, --slug, --concept, and --status required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    const r = db.prepare(`
      INSERT INTO traces (codebase_id, feature_name, slug, concept, status, dimension, verified_on, output_path, fragment_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(codebase_id, slug) DO UPDATE SET
        concept=excluded.concept, status=excluded.status, dimension=excluded.dimension,
        verified_on=excluded.verified_on, output_path=excluded.output_path,
        fragment_path=excluded.fragment_path, run_date=date('now'), created_at=datetime('now')
    `).run(codebaseId, featureName, slug, concept, status, dimension, verifiedOn, outputPath, fragmentPath);
    console.log(JSON.stringify({ trace_id: Number(r.lastInsertRowid), slug, status }));
    process.exit(0);
  }

  if (action === 'list') {
    const codebase    = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    const feature     = rest.includes('--feature')  ? rest[rest.indexOf('--feature')  + 1] : null;
    const statusFilt  = rest.includes('--status')   ? rest[rest.indexOf('--status')   + 1] : null;
    const limit       = rest.includes('--limit')    ? Number(rest[rest.indexOf('--limit') + 1]) : 50;
    if (!codebase) {
      console.error(JSON.stringify({ error: '--codebase required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    let q = 'SELECT * FROM traces WHERE codebase_id=?';
    const params: (number | string)[] = [codebaseId];
    if (feature)    { q += ' AND feature_name=?'; params.push(feature); }
    if (statusFilt) { q += ' AND status=?';       params.push(statusFilt); }
    q += ' ORDER BY run_date DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'summary') {
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    const feature  = rest.includes('--feature')  ? rest[rest.indexOf('--feature')  + 1] : null;
    if (!codebase) {
      console.error(JSON.stringify({ error: '--codebase required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    let q = 'SELECT status, COUNT(*) as count FROM traces WHERE codebase_id=?';
    const params: (number | string)[] = [codebaseId];
    if (feature) { q += ' AND feature_name=?'; params.push(feature); }
    q += ' GROUP BY status';
    const rows = db.prepare(q).all(...params);
    console.log(JSON.stringify(rows));
    process.exit(0);
  }

  if (action === 'show') {
    const slug     = rest.includes('--slug')     ? rest[rest.indexOf('--slug')     + 1] : null;
    const codebase = rest.includes('--codebase') ? rest[rest.indexOf('--codebase') + 1] : null;
    if (!slug || !codebase) {
      console.error(JSON.stringify({ error: '--codebase and --slug required' }));
      process.exit(1);
    }
    const codebaseId = resolveCodbase(db, codebase);
    const row = db.prepare('SELECT * FROM traces WHERE codebase_id=? AND slug=?').get(codebaseId, slug);
    console.log(row ? JSON.stringify(row) : JSON.stringify({ error: 'not found' }));
    process.exit(0);
  }

  console.error(JSON.stringify({ error: `Unknown traces action: ${action}` }));
  process.exit(1);
}

console.error(`Unknown group: ${group}`);
printUsage(console.error);
process.exit(1);
