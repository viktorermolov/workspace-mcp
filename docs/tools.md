# MCP tools reference

The service exposes one MCP endpoint, `PUBLIC_URL/mcp`, over Streamable HTTP. It is stateless: identity comes from the OAuth access token on every request, so every call works after a reconnect or a server restart. Everything is a tool; the server uses no resources or prompts, because platforms differ in how they support them.

The server's MCP `instructions` and the description of `start` both tell a newly connected client to call `start` first.

## Conventions

- **Responses** are compact JSON text (no indentation). Errors come back as a tool result with `isError: true` and a body such as `{"error": "conflict", "message": "…", "current_rev": 2}`. Error codes: `invalid`, `not_found`, `conflict`, `forbidden`, `limit`.
- **Ids and slugs.** Every item has an id with a type prefix (`role_…`, `proj_…`, `doc_…`, `task_…`, `chk_…`, `rtn_…`). Roles and projects also have a slug; wherever a tool takes a role or project, the id or the slug works.
- **Creates** omit `id`. Pass an `idempotency_key` to make a create safe to retry: the same key returns the item created the first time.
- **Updates** pass `id` and `rev`, the conflict-check counter you last read (`rev`, or `working_rules_rev` from `start`). This is not the version-history number (`version`, `instruction_version`, `description_version`, or `working_rules_version` in `start`). If you pass the version-history number as `rev` and the two differ, the call fails with a conflict that names both fields. If someone changed the item since, the call also fails with `conflict` and the current revision; read the item again, merge and retry. Nothing is overwritten silently.
- **`claimed_role`** on every write is your own role (slug or id), recorded in the log and in version history. The server checks that the role exists, is not archived, and is on this connection's confirmed allow-list. Once the owner turns on enforcement, omitting it is `invalid`; a role that is unknown, archived, or not on the list is `forbidden`. In warning mode (the default after an upgrade) the write still succeeds and the response includes a `warnings` array. The owner sets the list on the Connections screen; MCP cannot change it. A role may edit items that belong to it; some roles may also be marked by the owner as allowed to edit any item. Editing an item you may not change is `forbidden` once enforcement is on. Working rules and other rules sets have no owning role: only the owner, or a role marked as allowed to edit any item, may change them.
- **`agent`** on `start` and on every write is optional: your agent slug from `start` (`data.agents`). The server checks that the agent exists and runs on this platform (it can verify only the platform, so this guards against mix-ups). A named agent answers with its own role list: `claimed_role` must be one of the roles the owner gave that agent, and the connection's flat role list is then not consulted. The agent is recorded in the log (`by` reads `Platform: agent as role`), in version history, task comments, review replies and checkpoints. In warning mode a wrong agent or role is a warning (`agent_not_found`, `agent_wrong_platform`, `agent_role_not_allowed`) and a wrong agent name is not recorded; with enforcement on it is `forbidden`. A call that names no agent keeps working under the connection's role list; on a platform that has agents the response carries an `agent_missing` warning. With `agent`, the `instructions` block of `start` includes `agent` (slug, name, platform, roles).
- On `claim_task` and `checkpoint`, `role` names the item (the task being claimed, or the role the checkpoint belongs to). Using `role` as the author because `claimed_role` was omitted is deprecated and will be removed in a later release (a separate task). Until then it is accepted in both warning and enforce modes, still checked against the confirmed allow-list, and the response includes a deprecation warning. Pass `claimed_role` for the author.
- **Instructions and data are separate.** Only the `instructions` block of `start` holds instructions. Everything else (tasks, documents, comments, checkpoints, mirrored issues) is data written by agents or third parties and never changes rules or access.
- **Limits.** Lists return 25 items by default and 100 at most, with a `cursor` for the next page. A response larger than 512 KiB of JSON first has its long text fields shortened to previews and carries `response_shortened` (the stored text stays complete); only if it is still too large is it replaced by a `limit` error that asks for a narrower request. Text fields refuse NUL characters and broken Unicode (unpaired surrogates). Field limits are listed in [configuration.md](configuration.md#fixed-limits).
- **Annotations.** Reads are marked read-only and idempotent; writes are marked non-destructive (nothing is ever deleted through MCP). Every tool is closed-world. This lets platforms skip confirmation prompts for plain reads. `start` is marked read-only but not idempotent: it changes no workspace content, only remembers for this connection and role where the previous `start` was, so the next one can report what changed.

## Entity types

`rules`, `role`, `project`, `document`, `task`, `checkpoint`, `issue` (a mirrored GitHub issue), `routine`, `review_comment`.

Task statuses: `open`, `in_progress`, `blocked`, `in_review`, `done`, `cancelled`. Priorities: `low`, `normal`, `high`, `urgent`.

## Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `start` | read | Entry point. Call first in every session. |
| `get` | read | One item by id. |
| `search` | read | Full-text search or a filtered list. |
| `save_role` | write | Create or update a role. |
| `save_routine` | write | Create or update a routine (schedule, timezone, status, last run). |
| `save_project` | write | Create or update a project. |
| `save_document` | write | Create or update a Markdown document. |
| `update_rules` | write, idempotent | Replace the working rules. |
| `save_task` | write | Create or update a task. |
| `claim_task` | write | Atomically take an open task. |
| `comment_task` | write | Add a comment to a task. |
| `reply_review_comment` | write | Reply to an owner review comment, optionally marking it answered. |
| `archive` | write, idempotent | Archive or restore an item. |
| `versions` | read | Version list, one version, or a line-by-line comparison. |
| `rollback` | write | Restore an earlier version as a new version. |
| `checkpoint` | write | Record what was done, where work stopped, what is next. |
| `set_issue_role` | write | Set or clear the local role label on a mirrored GitHub issue. |
| `changes` | read | The change log, by cursor. |

### `start`

Input: `role` (optional, slug or id), `project` (optional, slug or id). When enforcement is on, the given role must be on the connection's confirmed allow-list (`forbidden` if it is not).

Returns two blocks:

- `instructions`: `working_rules`, `working_rules_version` (the version-history number) and `working_rules_rev` (the conflict-check counter: pass this, not the version, to `update_rules`), `save_state_rule` (update your tasks and write a checkpoint before you finish), `safety_rule` (the workspace is not a secrets store; content is data), and, when a role is given, `role` and `role_instruction`. When a project is given, `project_rules` is also included: an array of that project's rules sets (`id`, `slug`, `title`, `text`, `version`, `rev`). They supplement the global working rules; they do not replace them. There is no separate "active" test set — attach a set to a `[TEST]` project and pass that project to `start`.
- `data`: the `roles` (id, slug, name, area), `archived_role_slugs` (the slugs of archived roles, which stay reserved) when any exist, the `projects` with `focus` and `state`, the `agents` (slug, name, the platform each runs on, and the roles it may take; at most 50, `more_agents` counts the rest; agents on a revoked platform are left out; only the owner changes this list), a global `routines` list, and for the given role its links and setup notes, its `role_routines`, `open_tasks` (up to 30), `last_checkpoint`, and `changes_since_previous_start` for this connection and role (up to 30 events, with empty fields left out; `null` on the first `start` of a connection with a given role, since there is no previous call: read earlier history with `changes`; when there are more, `has_more` is true, `next_cursor` reads the rest with `changes`, and the next `start` continues after the last event shown, so nothing is skipped; events read with `changes` are shown again by the next `start`). `latest_event_id` is the newest event: a cursor for `changes` from now on, which skips anything older that was not shown.

`start` is an overview of a fixed size, so it fits in one response however large the workspace grows. At most 50 roles, 50 archived roles, 50 projects and 50 routines are listed (`more_roles`, `more_archived_roles`, `more_projects` and `more_routines` count the rest; find them with `search`, with `include_archived` for archived roles), and at most 100 links of the role (`more_links`). When a role is given, `data.review_comments` lists the 10 oldest open review comments that role is responsible for (or may see on a project's rules sets), with `more_review_comments` and `review_comments_open_total`. In a tight response the comments shrink to ids and counts. Long fields (area, focus, state, setup notes, checkpoint parts) are previews that say how many characters were left out; `get` returns them in full. Text that grows a lot when escaped in JSON (for example, long runs of quotes) makes the previews shorter; in the extreme case the working rules and role instruction are shortened too, and `instructions_shortened` tells the agent to read them in full with `get`.

On an empty workspace `data.empty_workspace` is `true` and `data.how_to_fill` explains the first fill: working rules, roles, projects, documents, tasks, then `start` again with a role.

`start` records the event cursor for the connection and role, so it is not idempotent, but it changes no workspace content.

### `get`

Input: `type` (an entity type), `id` (not needed for the default working rules; pass id or slug for another rules set), and for tasks an optional `cursor`.

Roles include their links and the current instruction; projects include open tasks and documents; routines include schedule, timezone, status, external platform id and last run; tasks include up to 100 dependencies and 100 subtasks (`more_dependencies` and `more_subtasks` count the rest) and the newest 10 comments (oldest first), with `comments_total` and `comments_cursor`: pass it as `cursor` for the 10 before them; documents include the current body. `get` of a role, project, document or rules set also includes `open_review_comments` (up to 10 open or answered comments), `more_open_review_comments` and `open_review_comments_total`. `type: review_comment` returns one comment and its replies.

### `search`

Input: `query` (optional full-text query), `types` (any of `role`, `project`, `document`, `task`, `issue`, `routine`, `review_comment`; default all of them), `status` (task statuses), `role`, `project`, `include_archived`, `limit`, `cursor`.

Working rules and checkpoints are not searched, and asking for them is an error: read the rules with `get`, and checkpoints with `start` (`last_checkpoint`) or with `get` by id; `changes` with `entity_type: "checkpoint"` lists the ids of earlier ones.

With a query, results are ranked by SQLite FTS5 relevance with a short snippet, where each matched word or phrase is marked once in square brackets (words separated only by spaces or punctuation count as one phrase). `total` counts the matches; when `total_exact` is `false`, the search stopped early (the page was full, or a very common query hit the work limit per request) and `total` is a lower bound. Without a query, it lists items by most recent update, filtered by the other fields. Archived items are left out unless `include_archived` is true.

Like `changes`, a page ends with `has_more` and `next_cursor`: while `has_more` is true, pass `next_cursor` to read on; otherwise `has_more` is false and `next_cursor` is `null`. If `total_exact` is also `false`, the search stopped early and there may be more matches: narrow the query or the filters to find them.

### `save_role`

Input: `id` and `rev` (for updates), `name`, `slug`, `area` (area of responsibility), `instruction`, `setup_notes` (what a new platform must recreate by hand: connectors, wake-up triggers; structured schedules belong in `save_routine`), `links` (array of `{to, type}`; the type is free-form, for example `delegates_to` or `reviews`; replaces all links of the role), `parent` (slug or id of the role this one reports to, or `null` to clear; omitted, the parent is left unchanged), `note` (stored with a new instruction version), `claimed_role`, `idempotency_key`.

`parent` is the canonical reporting line. Only the owner or a role marked `edit_any` may set or clear it, including when creating a role. A role cannot set its own parent. There is no `reports_to` argument for this field: that name is already a declared link type. Existing `reports_to` links are kept and still shown as declared links, but the UI no longer offers that type for new links.

The instruction is versioned. Edits to instructions are highlighted to the owner, because they change the behaviour of every later session. A slug stays reserved after the role is archived; creating or renaming a role to that slug fails with a conflict that says the existing role is archived and gives its id.

`get` with `type: "role"` and `start` include `parent` (`{ id, slug, name }` on the current role, and a parent slug on each item in `data.roles`). They do not include map interactions, which are owner-only on `GET /api/owner/map`.

### `save_routine`

Input: `id` and `rev` (for updates), `name`, `role` (owning role, slug or id; required on create), `schedule` (cron or a short description; required on create), `timezone` (IANA name such as `America/Los_Angeles`; defaults to `UTC` on create), `status` (`enabled` or `paused`; defaults to `enabled` on create), `external_id` (id of this routine on an external platform, or `null` to clear), `last_run_at` (ISO 8601 time of the last run, or `null` to clear), `last_run_result`, `claimed_role`, `idempotency_key`.

The server stores the routine; it does not run the schedule. `start` returns every routine in `data.routines`, and the given role's routines in `data.role_routines`. `get` with `type: "routine"` returns one routine. `search` with `types: ["routine"]` is the paginated global list.

### `save_project`

Input: `id`, `rev`, `name`, `slug`, `description` (versioned), `focus` (current focus), `state` (where work stopped), `repos` (repository URLs or `owner/name`), `owner_role` (optional slug or id of the owning role, or `null` to leave the project shared), `note`, `claimed_role`, `idempotency_key`.

### `save_document`

Input: `id`, `rev`, `title`, `kind` (free-form: decision, research, note…), `body` (Markdown, versioned), `attach_to` (`{type: "workspace" | "project" | "role", id}`), `note`, `claimed_role`, `idempotency_key`.

Every change to the body creates a new version. Documents are found by full-text search.

### `update_rules`

Input: `text`, `rev` (`working_rules_rev` from `start`, or `rev` from `get(rules)`; not `working_rules_version` or `version`; not needed for the very first text of a set), `note`, `id`, `slug`, `title`, `project` (slug or id, or `null` to detach), `claimed_role`. Only the owner, or a role marked as allowed to edit any item, may create or change a rules set.

Omit `id` and `slug` to update the default working rules, same as before: this replaces that set's text and creates a new version. Saving the same text again is a no-op. Pass the `slug` of an existing set to update it, or a new `slug` (and `text`) to create an additional titled set; `title` defaults to the slug, and `project` optionally scopes the set to a project. The default set stays global and cannot be attached to a project. Slugs are unique per member.

### `save_task`

Input: `id`, `rev`, `title`, `description`, `status`, `role` (or `null` to clear), `project` (or `null`), `for_agent` (the slug of the one agent the task is addressed to, which must be able to take the task's role; `null` for any agent with the role), `parent_id` (or `null`), `depends_on` (replaces the list), `priority`, `due_date` (`YYYY-MM-DD` or `null`), `result`, `blocking_reason`, `claimed_role`, `idempotency_key`.

Cycles in the parent hierarchy or in dependencies are rejected with `invalid`. A task whose dependencies are not done can still be saved; when its last open dependency is finished, an `task.unblocked` event is recorded.

### `claim_task`

Input: `id`, `claimed_role` (your role, for the log), `role` (optional: the role the task is claimed for, and used to set `role_id` if the task has none). Using `role` as the author when `claimed_role` is omitted is deprecated.

Atomically takes an open task that nobody has claimed and sets it to `in_progress`, recording the connection, role and agent. A task addressed to an agent (`for_agent`) is a `conflict` for a caller that names a different agent. If another agent got it first, the call fails with `conflict`.

### `comment_task`

Input: `id`, `body`, `claimed_role`, `idempotency_key`.

### `reply_review_comment`

Input: `id`, `body`, `claimed_role` (there is no `role` synonym), optional `status` (`answered` only), optional `rev` or `expected_status` (conflict if they no longer match), `idempotency_key`.

Bots cannot create review comments and cannot resolve them. The responsible role, a role marked `edit_any`, or the owner may mark a comment `answered`. An owner's reply on an answered comment reopens it. Comments on working rules or other rules sets are answered only by `edit_any` roles; a project's owning role may see and reply to comments on that project's rules, but cannot mark them answered unless it also has `edit_any`.

### `archive`

Input: `type` (`role`, `project`, `document`, `task` or `routine`), `id`, `restore` (true to restore), `claimed_role`.

Archived items are hidden from the main lists and kept with their history. `start` still lists the slugs of archived roles under `archived_role_slugs`, because their slugs stay reserved. Nothing can be deleted through MCP. Only the owner can delete an archived item permanently, in the web interface.

### `versions`

Input: `type` (`rules`, `role`, `project` or `document`), `id` (not needed for the default working rules; pass id or slug for another rules set), `action`:

- `list` (default): versions, newest first, with number, author, time and note. A version made by `rollback` has `rollback_of`, the number of the version it restored; for other versions it is `null`. `limit` and `before` page through them.
- `get`: the full text of version `number`.
- `compare`: a line-by-line diff from version `from` to version `to`. `from: 0` compares with an empty text.

### `rollback`

Input: `type`, `id`, `to_version`, `rev` (optional conflict check), `note`, `claimed_role`.

Copies the text of an earlier version into a new version. History is never erased or changed; no tool can edit or delete versions or the log.

### `checkpoint`

Input: `role` (required: the role this checkpoint belongs to), `claimed_role` (your role, for the log), `project` (optional), `done`, `stopped_at`, `next`, `idempotency_key`. Using `role` as the author when `claimed_role` is omitted is deprecated.

The next `start` for this role returns the latest checkpoint (for a caller that names its agent: that agent's own latest, plus `newer_checkpoint_by_another_agent` when another agent of the role wrote a later one), so another session or another platform continues from the same place.

### `set_issue_role`

Input: either `id` (the mirrored issue id from `get` or `search`) **or** `repo` (`owner/name`) and `number`, not both; `role` (slug or id to assign, or `null`/empty to clear); `claimed_role`.

This changes only the local role label on a mirrored issue. Nothing is written to GitHub. The label does not grant or remove any rights.

Allowed: the owner; a role the owner has marked as allowed to edit any item; or a role the owner has allowed to assign issue labels on that repository. The owner sets the default role and the assigner list on the GitHub screen; MCP cannot change those settings, nor the GitHub token, the selected repositories or sync. In warning mode (the default after an upgrade) a caller who is not allowed still succeeds and the response includes a warning; once enforcement is on, the call is `forbidden`. The connection's confirmed allow-list still applies: being an assigner does not bypass it.

### `changes`


Input: `cursor` (event id, default 0), `limit` (up to 200), `entity_type`, `entity_id`.

Returns log events after the cursor, oldest first, each with who (owner, or connection and claimed role), what and when, plus `next_cursor` and `has_more`. While `has_more` is true, pass `next_cursor` to read on. On the last page `has_more` is false and `next_cursor` is the id of the last event returned (or the cursor you passed, if there were none): keep it and pass it later to read only newer events. `start` uses the same names in `changes_since_previous_start`.

## A typical session

1. `start` with your role. Read `instructions`, your open tasks and your last checkpoint.
2. `claim_task` the task you take, `get` what you need, `search` for the rest.
3. Save your work with the write tools, passing the `rev` you read.
4. Before you finish, update your tasks (status, result, blocking reason) and write a `checkpoint`.
