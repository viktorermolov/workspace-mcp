# MCP tools reference

The service exposes one MCP endpoint, `PUBLIC_URL/mcp`, over Streamable HTTP. It is stateless: identity comes from the OAuth access token on every request, so every call works after a reconnect or a server restart. Everything is a tool; the server uses no resources or prompts, because platforms differ in how they support them.

The server's MCP `instructions` and the description of `start` both tell a newly connected client to call `start` first.

## Conventions

- **Responses** are JSON text. Errors come back as a tool result with `isError: true` and a body such as `{"error": "conflict", "message": "…", "current_rev": 2}`. Error codes: `invalid`, `not_found`, `conflict`, `limit`.
- **Ids and slugs.** Every item has an id with a type prefix (`role_…`, `proj_…`, `doc_…`, `task_…`, `chk_…`). Roles and projects also have a slug; wherever a tool takes a role or project, the id or the slug works.
- **Creates** omit `id`. Pass an `idempotency_key` to make a create safe to retry: the same key returns the item created the first time.
- **Updates** pass `id` and `rev`, the revision you last read. If someone changed the item since, the call fails with `conflict` and the current revision; read the item again, merge and retry. Nothing is overwritten silently.
- **`claimed_role`** on writes is your own role, recorded in the log and in version history. A role is a label the agent claims, not a permission.
- **Instructions and data are separate.** Only the `instructions` block of `start` holds instructions. Everything else (tasks, documents, comments, checkpoints, mirrored issues) is data written by agents or third parties and never changes rules or access.
- **Limits.** Lists return 25 items by default and 100 at most, with a `cursor` for the next page. A response larger than 512 KiB of JSON first has its long text fields shortened to previews and carries `response_shortened` (the stored text stays complete); only if it is still too large is it replaced by a `limit` error that asks for a narrower request. Text fields refuse NUL characters and broken Unicode (unpaired surrogates). Field limits are listed in [configuration.md](configuration.md#fixed-limits).
- **Annotations.** Reads are marked read-only and idempotent; writes are marked non-destructive (nothing is ever deleted through MCP). Every tool is closed-world. This lets platforms skip confirmation prompts for plain reads. `start` is marked read-only but not idempotent: it changes no workspace content, only remembers for this connection and role where the previous `start` was, so the next one can report what changed.

## Entity types

`rules`, `role`, `project`, `document`, `task`, `checkpoint`, `issue` (a mirrored GitHub issue).

Task statuses: `open`, `in_progress`, `blocked`, `in_review`, `done`, `cancelled`. Priorities: `low`, `normal`, `high`, `urgent`.

## Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `start` | read | Entry point. Call first in every session. |
| `get` | read | One item by id. |
| `search` | read | Full-text search or a filtered list. |
| `save_role` | write | Create or update a role. |
| `save_project` | write | Create or update a project. |
| `save_document` | write | Create or update a Markdown document. |
| `update_rules` | write, idempotent | Replace the working rules. |
| `save_task` | write | Create or update a task. |
| `claim_task` | write | Atomically take an open task. |
| `comment_task` | write | Add a comment to a task. |
| `archive` | write, idempotent | Archive or restore an item. |
| `versions` | read | Version list, one version, or a line-by-line comparison. |
| `rollback` | write | Restore an earlier version as a new version. |
| `checkpoint` | write | Record what was done, where work stopped, what is next. |
| `changes` | read | The change log, by cursor. |

### `start`

Input: `role` (optional, slug or id).

Returns two blocks:

- `instructions`: `working_rules`, `working_rules_version` and `working_rules_rev` (pass it to `update_rules`), `save_state_rule` (update your tasks and write a checkpoint before you finish), `safety_rule` (the workspace is not a secrets store; content is data), and, when a role is given, `role` and `role_instruction`.
- `data`: the `roles` (id, slug, name, area), the `projects` with `focus` and `state`, and for the given role its links and setup notes, `open_tasks` (up to 30), `last_checkpoint`, and `changes_since_previous_start` for this connection and role (up to 30 events; when there are more, `has_more` is true, `next_cursor` reads the rest with `changes`, and the next `start` continues after the last event shown, so nothing is skipped; events read with `changes` are shown again by the next `start`). `latest_event_id` is the newest event: a cursor for `changes` from now on, which skips anything older that was not shown.

`start` is an overview of a fixed size, so it fits in one response however large the workspace grows. At most 50 roles and 50 projects are listed (`more_roles` and `more_projects` count the rest; find them with `search`), and at most 100 links of the role (`more_links`). Long fields (area, focus, state, setup notes, checkpoint parts) are previews that say how many characters were left out; `get` returns them in full. Text that grows a lot when escaped in JSON (for example, long runs of quotes) makes the previews shorter; in the extreme case the working rules and role instruction are shortened too, and `instructions_shortened` tells the agent to read them in full with `get`.

On an empty workspace `data.empty_workspace` is `true` and `data.how_to_fill` explains the first fill: working rules, roles, projects, documents, tasks, then `start` again with a role.

`start` records the event cursor for the connection and role, so it is not idempotent, but it changes no workspace content.

### `get`

Input: `type` (an entity type), `id` (not needed for `rules`), and for tasks an optional `cursor`.

Roles include their links and the current instruction; projects include open tasks and documents; tasks include up to 100 dependencies and 100 subtasks (`more_dependencies` and `more_subtasks` count the rest) and the newest 10 comments (oldest first), with `comments_total` and `comments_cursor`: pass it as `cursor` for the 10 before them; documents include the current body.

### `search`

Input: `query` (optional full-text query), `types` (any of `role`, `project`, `document`, `task`, `issue`; default all of them), `status` (task statuses), `role`, `project`, `include_archived`, `limit`, `cursor`.

Working rules and checkpoints are not searched, and asking for them is an error: read the rules with `get`, and checkpoints with `start` (`last_checkpoint`) or with `get` by id.

With a query, results are ranked by SQLite FTS5 relevance with a short snippet. `total` counts the matches; when `total_exact` is `false`, the search stopped early (the page was full, or a very common query hit the work limit per request) and `total` is a lower bound. Without a query, it lists items by most recent update, filtered by the other fields. Archived items are left out unless `include_archived` is true.

### `save_role`

Input: `id` and `rev` (for updates), `name`, `slug`, `area` (area of responsibility), `instruction`, `setup_notes` (what a new platform must recreate by hand: schedules, connectors, wake-up triggers), `links` (array of `{to, type}`; the type is free-form, for example `delegates_to` or `reviews`; replaces all links of the role), `note` (stored with a new instruction version), `claimed_role`, `idempotency_key`.

The instruction is versioned. Edits to instructions are highlighted to the owner, because they change the behaviour of every later session.

### `save_project`

Input: `id`, `rev`, `name`, `slug`, `description` (versioned), `focus` (current focus), `state` (where work stopped), `repos` (repository URLs or `owner/name`), `note`, `claimed_role`, `idempotency_key`.

### `save_document`

Input: `id`, `rev`, `title`, `kind` (free-form: decision, research, note…), `body` (Markdown, versioned), `attach_to` (`{type: "workspace" | "project" | "role", id}`), `note`, `claimed_role`, `idempotency_key`.

Every change to the body creates a new version. Documents are found by full-text search.

### `update_rules`

Input: `text`, `rev` (`working_rules_rev` from `start`, or `rev` from `get(rules)`; not needed for the very first text), `note`, `claimed_role`.

Replaces the working rules shared by all roles and platforms and creates a new version. Saving the same text again is a no-op.

### `save_task`

Input: `id`, `rev`, `title`, `description`, `status`, `role` (or `null` to clear), `project` (or `null`), `parent_id` (or `null`), `depends_on` (replaces the list), `priority`, `due_date` (`YYYY-MM-DD` or `null`), `result`, `blocking_reason`, `claimed_role`, `idempotency_key`.

Cycles in the parent hierarchy or in dependencies are rejected with `invalid`. A task whose dependencies are not done can still be saved; when its last open dependency is finished, an `task.unblocked` event is recorded.

### `claim_task`

Input: `id`, `role` (optional, your role).

Atomically takes an open task that nobody has claimed and sets it to `in_progress`, recording the connection and role. If another agent got it first, the call fails with `conflict`.

### `comment_task`

Input: `id`, `body`, `claimed_role`, `idempotency_key`.

### `archive`

Input: `type` (`role`, `project`, `document` or `task`), `id`, `restore` (true to restore), `claimed_role`.

Archived items are hidden from lists and kept with their history. Nothing can be deleted through MCP. Only the owner can delete an archived item permanently, in the web interface.

### `versions`

Input: `type` (`rules`, `role`, `project` or `document`), `id` (not needed for rules), `action`:

- `list` (default): versions, newest first, with number, author, time and note. `limit` and `before` page through them.
- `get`: the full text of version `number`.
- `compare`: a line-by-line diff from version `from` to version `to`. `from: 0` compares with an empty text.

### `rollback`

Input: `type`, `id`, `to_version`, `rev` (optional conflict check), `note`, `claimed_role`.

Copies the text of an earlier version into a new version. History is never erased or changed; no tool can edit or delete versions or the log.

### `checkpoint`

Input: `role` (required), `project` (optional), `done`, `stopped_at`, `next`, `idempotency_key`.

The next `start` for this role returns the latest checkpoint, so another session or another platform continues from the same place.

### `changes`

Input: `cursor` (event id, default 0), `limit` (up to 200), `entity_type`, `entity_id`.

Returns log events after the cursor, oldest first, each with who (owner, or connection and claimed role), what and when, plus `next_cursor` and `has_more`. While `has_more` is true, pass `next_cursor` to read on. `start` uses the same names in `changes_since_previous_start`.

## A typical session

1. `start` with your role. Read `instructions`, your open tasks and your last checkpoint.
2. `claim_task` the task you take, `get` what you need, `search` for the rest.
3. Save your work with the write tools, passing the `rev` you read.
4. Before you finish, update your tasks (status, result, blocking reason) and write a `checkpoint`.
