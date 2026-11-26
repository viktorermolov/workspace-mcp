/**
 * Application schema migrations. Each entry runs once, in order, inside a transaction.
 * Never edit a released migration; add a new one.
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE member (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  name TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  last_review_event_id INTEGER NOT NULL DEFAULT 0,
  last_visit_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE purge_guard (id INTEGER PRIMARY KEY);

CREATE TABLE version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES member(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('rules','role','project','document')),
  entity_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  body TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  note TEXT,
  rollback_of INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, number)
);
CREATE TRIGGER version_immutable_update BEFORE UPDATE ON version
BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER version_immutable_delete BEFORE DELETE ON version
WHEN NOT EXISTS (SELECT 1 FROM purge_guard)
BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;

CREATE TABLE rules (
  member_id TEXT PRIMARY KEY REFERENCES member(id),
  current_version INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE role (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  setup_notes TEXT NOT NULL DEFAULT '',
  current_version INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, slug)
);

CREATE TABLE role_link (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  from_role_id TEXT NOT NULL REFERENCES role(id),
  to_role_id TEXT NOT NULL REFERENCES role(id),
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_role_id, to_role_id, type)
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  focus TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  repos TEXT NOT NULL DEFAULT '[]',
  current_version INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, slug)
);

CREATE TABLE document (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','project','role')),
  scope_id TEXT,
  current_version INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX document_scope ON document (member_id, scope_type, scope_id);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','in_review','done','cancelled')),
  role_id TEXT REFERENCES role(id),
  project_id TEXT REFERENCES project(id),
  parent_id TEXT REFERENCES task(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date TEXT,
  result TEXT NOT NULL DEFAULT '',
  blocking_reason TEXT NOT NULL DEFAULT '',
  claimed_by TEXT,
  claimed_role TEXT,
  created_by_kind TEXT NOT NULL,
  created_by_connection TEXT,
  created_by_role TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_role ON task (member_id, role_id, status);
CREATE INDEX task_project ON task (member_id, project_id, status);
CREATE INDEX task_parent ON task (parent_id);

CREATE TABLE task_dependency (
  task_id TEXT NOT NULL REFERENCES task(id),
  depends_on_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE task_comment (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  body TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX task_comment_task ON task_comment (task_id, created_at);

CREATE TABLE checkpoint (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  role_id TEXT NOT NULL REFERENCES role(id),
  project_id TEXT REFERENCES project(id),
  done TEXT NOT NULL,
  stopped_at TEXT NOT NULL,
  next TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX checkpoint_role ON checkpoint (member_id, role_id, created_at);

CREATE TABLE event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES member(id),
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX event_entity ON event (entity_type, entity_id, id);
CREATE TRIGGER event_immutable_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'the log is append-only'); END;
CREATE TRIGGER event_immutable_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'the log is append-only'); END;

CREATE TABLE idempotency (
  member_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, key)
);

CREATE TABLE connection (
  client_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  name TEXT NOT NULL,
  client_name TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  last_activity_at TEXT,
  revoked_at TEXT
);

CREATE TABLE start_cursor (
  connection_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  last_event_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, role_key)
);

CREATE TABLE oauth_diag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  client_id TEXT,
  step TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX oauth_diag_at ON oauth_diag (at);

CREATE TABLE setup_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup','recovery')),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE VIRTUAL TABLE search_fts USING fts5 (
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  member_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE github_config (
  member_id TEXT PRIMARY KEY REFERENCES member(id),
  token_enc TEXT NOT NULL,
  login TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_ok INTEGER,
  last_sync_message TEXT,
  last_sync_count INTEGER
);

CREATE TABLE github_repo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES member(id),
  full_name TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  created_at TEXT NOT NULL,
  last_synced_at TEXT,
  -- Set while a very large repository is synced over several runs: GitHub's update time to continue from.
  sync_cursor TEXT,
  UNIQUE (member_id, full_name)
);

CREATE TABLE github_issue (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  repo_id INTEGER NOT NULL REFERENCES github_repo(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  role_id TEXT REFERENCES role(id),
  synced_at TEXT NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE webhook (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  role_id TEXT NOT NULL REFERENCES role(id),
  url TEXT NOT NULL,
  auth_enc TEXT,
  signing_secret_enc TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_delivery (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')),
  events TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_delivery_due ON webhook_delivery (status, next_attempt_at);
`,
  },
  {
    id: 2,
    name: 'routines',
    sql: `
CREATE TABLE routine (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  role_id TEXT NOT NULL REFERENCES role(id),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL CHECK (status IN ('enabled','paused')),
  external_id TEXT,
  last_run_at TEXT,
  last_run_result TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX routine_role ON routine (member_id, role_id, status);
`,
  },
  {
    id: 3,
    name: 'titled-rules-sets',
    sql: `
-- Version and event rows for rules used to be keyed by member_id. Rewriting entity_id
-- requires dropping the immutable-update triggers for the duration of this migration.
DROP TRIGGER IF EXISTS version_immutable_update;
DROP TRIGGER IF EXISTS event_immutable_update;

CREATE TABLE rules_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  current_version INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, slug),
  CHECK (is_default = 0 OR project_id IS NULL)
);
CREATE UNIQUE INDEX rules_one_default ON rules_new (member_id) WHERE is_default = 1;

INSERT INTO rules_new (id, member_id, slug, title, project_id, is_default, current_version, rev, created_at, updated_at)
SELECT 'rul_' || lower(hex(randomblob(12))), member_id, 'working-rules', 'Working rules', NULL, 1, current_version, rev, updated_at, updated_at
FROM rules;

UPDATE version
SET entity_id = (SELECT id FROM rules_new WHERE rules_new.member_id = version.entity_id)
WHERE entity_type = 'rules';

UPDATE event
SET entity_id = (SELECT id FROM rules_new WHERE rules_new.member_id = event.entity_id)
WHERE entity_type = 'rules';

DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;

CREATE TRIGGER version_immutable_update BEFORE UPDATE ON version
BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER event_immutable_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'the log is append-only'); END;
`,
  },
];
