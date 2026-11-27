import type { DatabaseSync } from 'node:sqlite';
import { repairReauthDuplicateConnections } from './repair-reauth-duplicates.ts';
import { repairEmptyActiveDuplicates } from './repair-empty-active-duplicates.ts';

/**
 * Application schema migrations. Each entry runs once, in order, inside a transaction.
 * Never edit a released migration; add a new one.
 * `run`, if present, is a frozen function called after `sql` in the same transaction.
 * It may return log lines; the runner writes them only after the transaction commits.
 */
export type MigrationLog = { msg: string; fields: Record<string, unknown> };
export type Migration = {
  id: number;
  name: string;
  sql?: string;
  run?: (db: DatabaseSync) => MigrationLog[];
};

export const migrations: Migration[] = [
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
  // After #59's `titled-rules-sets` (id 3) on master. Never reuse id 2 or 3.
  {
    id: 4,
    name: 'connection_roles',
    sql: `
ALTER TABLE connection ADD COLUMN roles_confirmed_at TEXT;
ALTER TABLE connection ADD COLUMN roles_suggested_at TEXT;
CREATE TABLE connection_role (
  client_id TEXT NOT NULL REFERENCES connection(client_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','suggested')),
  PRIMARY KEY (client_id, role_id)
);
CREATE INDEX connection_role_role ON connection_role (role_id);
ALTER TABLE role ADD COLUMN edit_any INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member ADD COLUMN role_enforcement TEXT NOT NULL DEFAULT 'warn'
  CHECK (role_enforcement IN ('warn','enforce'));
ALTER TABLE project ADD COLUMN owner_role_id TEXT REFERENCES role(id);
`,
  },
  // After #61's `connection_roles` (id 4) on master.
  {
    id: 5,
    name: 'role_parent',
    sql: `
ALTER TABLE role ADD COLUMN parent_id TEXT REFERENCES role(id);
CREATE INDEX role_parent ON role (parent_id);
CREATE INDEX event_member_action ON event (member_id, action, id);
`,
  },
  {
    id: 6,
    name: 'review-comments',
    sql: `
CREATE TABLE setup_notes_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES member(id),
  role_id TEXT NOT NULL REFERENCES role(id),
  body TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX setup_notes_history_role ON setup_notes_history (role_id, id);
CREATE TRIGGER setup_notes_history_immutable_update BEFORE UPDATE ON setup_notes_history
BEGIN SELECT RAISE(ABORT, 'setup notes history is immutable'); END;
CREATE TRIGGER setup_notes_history_immutable_delete BEFORE DELETE ON setup_notes_history
WHEN NOT EXISTS (SELECT 1 FROM purge_guard)
BEGIN SELECT RAISE(ABORT, 'setup notes history can only be deleted during a purge'); END;

CREATE TABLE review_comment (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  field TEXT NOT NULL,
  body TEXT NOT NULL,
  version_id INTEGER REFERENCES version(id),
  line_start INTEGER,
  line_end INTEGER,
  quote TEXT NOT NULL DEFAULT '',
  quote_hash TEXT NOT NULL DEFAULT '',
  ctx_before TEXT NOT NULL DEFAULT '',
  ctx_after TEXT NOT NULL DEFAULT '',
  text_hash TEXT,
  setup_notes_id INTEGER REFERENCES setup_notes_history(id),
  anchor_version_id INTEGER REFERENCES version(id),
  anchor_line_start INTEGER,
  anchor_line_end INTEGER,
  anchor_state TEXT NOT NULL DEFAULT 'none' CHECK (anchor_state IN ('none','exact','moved','outdated')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved')),
  rev INTEGER NOT NULL DEFAULT 1,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX review_comment_target ON review_comment (member_id, target_type, target_id, field, status);
CREATE INDEX review_comment_status ON review_comment (member_id, status, created_at);
CREATE INDEX review_comment_version ON review_comment (version_id);
CREATE INDEX review_comment_anchor ON review_comment (anchor_version_id);

CREATE TABLE review_reply (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  comment_id TEXT NOT NULL REFERENCES review_comment(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  connection_id TEXT,
  connection_name TEXT,
  claimed_role TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX review_reply_comment ON review_reply (comment_id, created_at, id);
`,
  },
  // After #61's `connection_roles` (id 4) on master. 5 (role_parent, #79) and
  // 6 (review-comments, #87) have landed; this entry stays as id 7 (do not renumber).
  {
    id: 7,
    name: 'github-issue-roles',
    sql: `
ALTER TABLE github_repo ADD COLUMN default_role_id TEXT REFERENCES role(id) ON DELETE SET NULL;
CREATE TABLE github_repo_assigner (
  repo_id INTEGER NOT NULL REFERENCES github_repo(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (repo_id, role_id)
);
CREATE INDEX github_repo_assigner_role ON github_repo_assigner (role_id);
`,
  },
  // After #99's `github-issue-roles` (id 7). An agent is a named bot on one platform (connection)
  // with the roles it may take (decision 0006). Existing knowledge is carried over so the owner has
  // nothing to re-enter: one agent per active connection and active role that the connection is
  // listed for, or has already written as.
  {
    id: 8,
    name: 'agents',
    sql: `
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member(id),
  client_id TEXT REFERENCES connection(client_id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, slug)
);
CREATE INDEX agent_client ON agent (client_id);
CREATE TABLE agent_role (
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, role_id)
);
CREATE INDEX agent_role_role ON agent_role (role_id);

CREATE TABLE agent_backfill AS
SELECT 'agt_' || lower(hex(randomblob(8))) AS id, c.member_id AS member_id, c.client_id AS client_id, r.id AS role_id, r.name AS name,
  CASE WHEN row_number() OVER (PARTITION BY c.member_id, r.slug ORDER BY c.created_at, c.client_id) = 1 THEN r.slug
       ELSE substr(r.slug, 1, 56) || '-' || row_number() OVER (PARTITION BY c.member_id, r.slug ORDER BY c.created_at, c.client_id) END AS slug
FROM connection c JOIN role r ON r.member_id = c.member_id AND r.archived_at IS NULL
WHERE c.revoked_at IS NULL AND c.roles_confirmed_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM connection_role cr WHERE cr.client_id = c.client_id AND cr.role_id = r.id AND cr.source = 'owner');
INSERT OR IGNORE INTO agent (id, member_id, client_id, slug, name, rev, created_at, updated_at)
SELECT id, member_id, client_id, slug, name, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agent_backfill;
INSERT INTO agent_role (agent_id, role_id)
SELECT b.id, b.role_id FROM agent_backfill b WHERE EXISTS (SELECT 1 FROM agent a WHERE a.id = b.id);
DROP TABLE agent_backfill;
`,
  },
  // Step 2 of decision 0006: a call may name its agent; the records keep it next to the role.
  {
    id: 9,
    name: 'agent-authorship',
    sql: `
ALTER TABLE event ADD COLUMN agent TEXT;
ALTER TABLE version ADD COLUMN agent TEXT;
ALTER TABLE task_comment ADD COLUMN agent TEXT;
ALTER TABLE checkpoint ADD COLUMN agent TEXT;
ALTER TABLE review_reply ADD COLUMN agent TEXT;
`,
  },
  // Step 3 of decision 0006: a task may be addressed to one agent besides its role.
  {
    id: 10,
    name: 'task-for-agent',
    sql: `
ALTER TABLE task ADD COLUMN agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN claimed_agent TEXT;
CREATE INDEX task_agent ON task (agent_id);
`,
  },
  // #148: a role the owner marks may address any task to an agent, without the right to edit any item.
  {
    id: 11,
    name: 'role-routes-tasks',
    sql: `
ALTER TABLE role ADD COLUMN routes_tasks INTEGER NOT NULL DEFAULT 0;
`,
  },
  // #154: migration 8 numbered agent slugs ("builder-2" for a second connection with the role builder) and
  // skipped an agent in silence when that slug was also the slug of another role's agent. Migration 8 is
  // released, so this one adds the agents it skipped. It touches only what migration 8 left: a connection
  // whose list was confirmed again later, or a workspace where the owner has already added, changed or
  // removed any agent, is left alone, because a missing agent there may be the owner's choice.
  {
    id: 12,
    name: 'agents-skipped-by-slug',
    sql: `
CREATE TABLE agent_backfill AS
SELECT 'agt_' || lower(hex(randomblob(8))) AS id, c.member_id AS member_id, c.client_id AS client_id, r.id AS role_id, r.name AS name, r.slug AS role_slug
FROM connection c JOIN role r ON r.member_id = c.member_id AND r.archived_at IS NULL
WHERE c.revoked_at IS NULL AND c.roles_confirmed_at IS NOT NULL
  AND c.roles_confirmed_at <= (SELECT applied_at FROM app_migration WHERE id = 8)
  AND EXISTS (SELECT 1 FROM connection_role cr WHERE cr.client_id = c.client_id AND cr.role_id = r.id AND cr.source = 'owner')
  AND NOT EXISTS (SELECT 1 FROM agent a JOIN agent_role ar ON ar.agent_id = a.id WHERE a.client_id = c.client_id AND ar.role_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM event e WHERE e.member_id = c.member_id AND e.entity_type = 'agent');
INSERT OR IGNORE INTO agent (id, member_id, client_id, slug, name, rev, created_at, updated_at)
SELECT id, member_id, client_id, substr(role_slug, 1, 50) || '-' || substr(id, 5, 6), name, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agent_backfill;
INSERT INTO agent_role (agent_id, role_id)
SELECT b.id, b.role_id FROM agent_backfill b WHERE EXISTS (SELECT 1 FROM agent a WHERE a.id = b.id);
DROP TABLE agent_backfill;
`,
  },
  // #164: the owner can mark a platform as running one agent; calls that name no agent then count as that agent.
  {
    id: 13,
    name: 'connection-sole-agent',
    sql: `
ALTER TABLE connection ADD COLUMN sole_agent INTEGER NOT NULL DEFAULT 0;
`,
  },
  // After 0.5.0's `connection-sole-agent` (id 13). Repairs a re-auth duplicate: the later empty
  // platform's OAuth client is bound onto the earlier configured platform, and the empty row is
  // archived. See docs/decisions/0007-reauth-same-client.md. Never bump approved_at.
  {
    id: 14,
    name: 'repair-reauth-duplicate-connections',
    sql: `
ALTER TABLE connection ADD COLUMN current_client_id TEXT;
ALTER TABLE connection ADD COLUMN merged_into_client_id TEXT REFERENCES connection(client_id);
UPDATE connection SET current_client_id = client_id WHERE current_client_id IS NULL;
CREATE UNIQUE INDEX connection_current_client_id ON connection(current_client_id) WHERE current_client_id IS NOT NULL;
CREATE TRIGGER connection_current_client_default AFTER INSERT ON connection
WHEN NEW.current_client_id IS NULL
BEGIN
  UPDATE connection SET current_client_id = NEW.client_id WHERE rowid = NEW.rowid;
END;
CREATE TABLE connection_transfer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES member(id),
  platform_client_id TEXT NOT NULL,
  from_client_id TEXT NOT NULL,
  to_client_id TEXT NOT NULL,
  previous_approved_at TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reauth','migration')),
  archived_client_id TEXT,
  rolled_back_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX connection_transfer_platform ON connection_transfer (platform_client_id, id);
`,
    run: (db) => repairReauthDuplicateConnections(db),
  },
  // After 0.6.0's `repair-reauth-duplicate-connections` (id 14). Archives an empty
  // same-type duplicate that migration 14 left in place because the original was
  // still in use (`original_still_active`), when the pair is unique and the
  // duplicate has no agents, no roles, and no journal besides its own approval.
  // The original platform and its tokens are not changed. See
  // docs/decisions/0009-reauth-configured-candidates.md. No binding table is added;
  // the original's accepted client is unchanged. An unused consent is not
  // configuration and is revoked so the archived client cannot obtain a token.
  // The owner can undo the archive.
  {
    id: 15,
    name: 'repair-empty-active-duplicates',
    run: (db) => repairEmptyActiveDuplicates(db),
  },
];
