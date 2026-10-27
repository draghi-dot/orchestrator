import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE snapshots (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL REFERENCES targets(id),
    root_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    commit_sha TEXT,
    file_count INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    stack TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE dna_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    rules TEXT NOT NULL,
    parent_id TEXT,
    note TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    contract_hash TEXT NOT NULL,
    contract TEXT NOT NULL,
    state TEXT NOT NULL,
    terminal_reason TEXT,
    summary TEXT,
    app_url TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    role TEXT NOT NULL,
    phase TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    runtime TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    owner_generation INTEGER NOT NULL,
    status TEXT NOT NULL,
    terminal_reason TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    last_heartbeat_at TEXT,
    UNIQUE (run_id, phase, ordinal, attempt_number)
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_run_seq ON events (run_id, seq);
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT REFERENCES tasks(id),
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    label TEXT NOT NULL,
    redaction TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tool_calls (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    tool_call_id TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (task_id, tool_call_id)
  );
  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,
    runtime TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    severity TEXT NOT NULL,
    area TEXT NOT NULL,
    location TEXT,
    reproduction TEXT,
    status TEXT NOT NULL,
    verdict_reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE challenges (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    runtime TEXT NOT NULL,
    stance TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (claim_id, task_id)
  );
  CREATE TABLE replays (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL,
    artifact_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE claim_reviews (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id),
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT,
    version INTEGER NOT NULL,
    author TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, version)
  );
  CREATE TABLE rule_changes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    runtime TEXT NOT NULL,
    op TEXT NOT NULL,
    rule_id TEXT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_by TEXT,
    decision_reason TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
  );
  `,
]

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  let version = row?.version ?? 0
  if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(MIGRATIONS[version])
      version += 1
      db.prepare('UPDATE schema_version SET version = ?').run(version)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}
