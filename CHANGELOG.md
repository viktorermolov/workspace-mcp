# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- A task of a role that several agents may take must name its agent. `save_task` that creates a task, or changes its role or `for_agent`, without an agent (`for_agent` left out, empty or `null`) for such a role is refused with `invalid`; the error names the role and its agents, and nothing is created or changed. A role with one agent gets that agent, and a role with no agents behaves as before. `for_agent: "*"` is the explicit "any agent of the role" and needs a role. The owner's task form follows the same rule and offers "any agent with the role". Other edits of an existing task are not re-checked. See `docs/decisions/0010-require-for-agent-on-multi-agent-roles.md`. (#181)
- Before 1.0, a breaking change is a minor version, a fix without new functionality is a patch, and 1.0.0 is released only on the owner's explicit decision. The README and [0008](docs/decisions/0008-semver.md) follow this rule. (#181)

### Fixed

- Re-authorizing a product while the original platform is still in use no longer treats an empty same-type duplicate as a matching candidate, so the consent screen does not push the owner toward a third platform. Only platforms with agents or owner-confirmed roles count as matches. When exactly one such platform matches, it is continued automatically, and any empty same-type duplicate (no agents, no roles, no journal besides its own approval) is archived in the same step. The consent screen says that empty platform will be archived. A duplicate that is configured in any way is never touched automatically. The owner can undo the transfer, including the archive, from Platforms. (#178)
- An empty same-type duplicate that was already created while the original was still in use is archived by migration 15 when the pair is unique and the duplicate has no agents, no roles, and no journal besides its own approval. The original platform and its tokens are not changed. The duplicate's unused consent and grants are revoked so that client cannot obtain a token. An empty consent row is not treated as configuration. A lone platform, with or without an agent, is left as it is. The owner can undo the archive from Platforms; that undo restores the empty platform and does not drop the original's tokens or change its approval time. (#178)
- A task addressed to an agent, or claimed by a named agent, can no longer have its status, result, blocking reason or role changed, be reopened, archived, or re-addressed (including clearing the addressee or addressing someone else), except by the addressee, the owner, or a coordinator re-addressing it. This holds in both warn and enforce mode. The refusal uses the same wording as claiming the task. Re-addressing a claimed in-progress task clears the claim so the new addressee must claim it before continuing. (#180)

### Upgrade

- Upgrading from 0.6.0 applies one migration (15, `repair-empty-active-duplicates`) automatically, after a pre-migration backup. Existing data is kept.
- Make a local backup of the database before upgrading.
- After the upgrade, an empty same-type duplicate that was left in place because the original was still in use is archived when the pair is unique and the duplicate has no agents, no roles, and no journal besides its own approval. The original platform and its tokens are not changed. The owner can undo the archive from Platforms → “Undo last client transfer” without dropping the original platform's tokens or changing its approval time. Anything that is not a unique empty duplicate is left as it is and recorded in the log.
- Upgrading from 0.5.0 applies migrations 14 and 15. Migration 14 still binds a unique later empty duplicate when the original was unused after that duplicate was approved; migration 15 then archives a leftover empty duplicate of a still-used original, as above.
- Rollback to 0.6.0 or 0.5.0 is possible only by restoring the pre-migration backup.
- Calls that create or re-address a task of a role with several agents without naming the agent now fail with `invalid`. Pass the agent's slug in `for_agent`, or `"*"` for any agent of the role; `null` no longer means "any agent" for such a role.
- Existing tasks with no agent are unchanged by the upgrade and can still be edited. To address one, call `save_task` with its `id`, `rev` and `for_agent` (the owner, its role, or a coordinator role).
- Roles with one agent are addressed to that agent automatically, and older connectors whose tools have no `for_agent` keep working with no reconnect.

## [0.6.0] - 2026-11-27

### Fixed

- Approving the same product again no longer creates a second, empty platform. The original platform keeps its agents and confirmed roles, and the new OAuth client is bound to it when it is clearly the same client; otherwise the consent screen asks whether to continue a platform or start a new one. A revoked platform is not offered. The owner can undo the last client transfer (a re-auth bind or a merge performed by migration 14) from Platforms; tokens issued before the undo stop working for both clients. Migration 14 repairs an existing one-to-one duplicate (the later empty platform is archived, the live token is kept, `approved_at` is not bumped) after the usual pre-migration backup. (#174, #176)

### Upgrade

- Upgrading from 0.5.0 applies one migration (14, `repair-reauth-duplicate-connections`) automatically, after a pre-migration backup. Existing data is kept.
- Make a local backup of the database before upgrading.
- After the upgrade, a later empty platform that was created by reconnecting the same product is merged into the earlier configured one when the pair is unique and the original was unused after the duplicate was approved. Anything ambiguous is left as it is and recorded in the log.
- Reconnecting a platform from the product still opens the consent screen. When the client is the same type as exactly one active platform, the screen says it continues that platform. Otherwise you choose to continue a platform or start a new one (the default).
- Undo a client transfer (a re-auth bind or a merge performed by migration 14) from Platforms → “Undo last client transfer”. Access and refresh tokens issued before the undo stop working for both clients; each client gets new tokens only through a fresh consent.
- Rollback to 0.5.0 is possible only by restoring the pre-migration backup.

## [0.5.0] - 2026-11-27

### Added

- `search` takes `for_agent`: only tasks addressed to that agent or taken by it. Task results show `for_agent` when the task is addressed. The `agent_missing` warning now also says what to do when the client's tools have no `agent` argument: the connector holds the tool list from before agents existed and has to be reconnected. (#165)
- A platform that runs one agent can say so. On the Platforms screen, under a platform with exactly one agent, the owner ticks "is the only agent on this platform"; a call that names no agent then counts as that agent: `start` returns its work, writes are recorded under it, and its roles apply instead of the platform's whole list. It is off by default and switches itself off when an agent is added to, moved to or from, or removed from the platform, so nothing is recorded under the wrong agent. Migration 13 adds the mark. (#164)
- `start` by agent name alone: with `agent` and no `role`, an agent gets the instruction, open tasks, waiting owner comments, review comments, routines and last checkpoint of every role it may take, in one call (`instructions.role_instructions`, `data.my_roles`, `data.last_checkpoint`). An agent with one role gets what `start` with that role returns. Passing `role` still narrows to one role. (#162)

### Changed

- README explains platforms, agents and roles. The instruction to paste into a platform now has two texts: for a platform with agents the bot starts with its agent name alone, and for a platform without agents with its role. The typical session in the tools reference starts by agent. (#166)

### Fixed

- The first `start` by agent name alone continued from the platform's role-less marker instead of the marker of the role the bot had been starting with, so changes were shown again or `changes_since_previous_start` was `null` and they were never shown. It now continues from the marker of the agent's role; for an agent with several roles from the oldest of their markers, so nothing is skipped and a change already seen under one role may be shown once more. (#172)
- Two agents of one role on one platform shared the marker for "changes since your previous start", so the first to call `start` used up the changes for the other. A named agent now has its own marker; its first `start` by name continues from the platform's marker for the role. (#162)

### Upgrade

- Upgrading from 0.4.1 applies one additive migration (13) automatically, after a pre-migration backup. Existing data is kept.
- Nothing changes for a bot until you act: `start` with a role works as before, and the one-agent mark is off for every platform.
- To let a bot start by name alone, give it the new text from `docs/agent-instruction.md`. A client that connected before 0.4.0 has to be reconnected to see the `agent` argument.
- If you tick "is the only agent on this platform", calls from that platform that name no agent are checked against that agent's roles instead of the platform's whole list. With enforcement on, a write under a role the platform has and the agent does not is then refused.
- A named agent's first `start` after the upgrade continues from the platform's marker for its role, so no change is skipped. An agent with several roles that starts by name alone continues from the oldest of their markers and may see once more a change it already saw under one of them.
- Rollback to 0.4.1 is possible only by restoring the pre-migration backup.

## [0.4.1] - 2026-11-27

### Fixed

- Upgrading from 0.3.1 or earlier could skip an agent without a message: migration 8 gives a second connection with the role `builder` the agent slug `builder-2`, and when that was also the slug of another role's agent, one of the two was dropped. Migration 12 adds the skipped agents under a free slug (`builder-2-1a2b3c`). It leaves a workspace alone once the owner has added, changed or removed any agent, and a connection whose role list was confirmed after the upgrade, because a missing agent there may be intended. Role checks were never affected. (#154)
- A misspelled tool argument is no longer dropped in silence. Every tool used to accept arguments it does not have and answer as if they were not there, so `search` with `statuses` instead of `status` returned tasks in every status. A write with an unknown argument is now refused before anything changes (`invalid`, with the argument, the likely intended name and the tool's arguments). A read is answered without it and carries an `unknown_arguments` warning. **A bot that passes a stray argument on a write will now get an error** instead of a quiet success. (#157)

### Upgrade

- Upgrading from 0.4.0 applies one additive migration (12) automatically, after a pre-migration backup. It adds agents only where migration 8 skipped one; on a workspace where the owner has already changed agents it does nothing.
- **Check your bots before upgrading:** a write that passes an argument the tool does not have is now refused. A bot that sends a stray or misspelled argument (for example `role` instead of `claimed_role` on `reply_review_comment`) got a quiet success in 0.4.0 and gets an `invalid` error in 0.4.1; the error names the right argument.
- Rollback to 0.4.0 is possible only by restoring the pre-migration backup.

## [0.4.0] - 2026-11-26

### Added

- A coordinating role can hand tasks to agents. On the Platforms the owner marks roles that may address tasks to agents; such a role may set or change `for_agent` on a task of any role, in a call that changes nothing else, and the agent must be able to take the task's role. It is narrower than "may edit any item" and, like it, cannot be granted through MCP. Migration 11 adds the mark. (#148)
- An agent has a page of its own (`/agents/<slug>`): the platform it runs on, the roles it may take, the open tasks addressed to it, other tasks it has taken, its own last checkpoint and its 20 most recent changes. The agent's name links to it from the Map, a role page and the Platforms. Owner only (`GET /api/owner/agents/:id`). (#130)
- Agents: a named bot on a platform (a connection) with the roles it may take. One platform can host several agents, and one role can be taken by agents on different platforms. The owner adds, edits and removes agents under each platform on the Platforms; `start` lists them (`data.agents`), and MCP cannot change them. On upgrade, migration 8 creates one agent for each active connection and each active role the owner has confirmed for it; a role a connection only claimed in a call, or that is only suggested, is not granted, and a connection with no confirmed roles gets no agent until the owner adds one (#138). Checks on writes are unchanged. A zip export carries agents with their roles and without their platform, because connections are never exported; after an import they wait under "Agents without a platform" on the Platforms until the owner attaches each to a platform (#146). (#107)

- Agents name themselves: `start` and every write tool take an optional `agent` (the agent's slug). The server checks that the agent runs on the calling platform and may take the named role, and records the agent in the log, version history, task comments, review replies and checkpoints, so two agents with the same role on one platform are told apart (`Grok: ada as developer`). A named agent answers with its own role list, which is always inside the list confirmed for its platform: the owner can give an agent only roles confirmed for the platform, and a role taken off the platform is taken off its agents (#140). A wrong agent or role is a warning in warning mode and `forbidden` with enforcement on. Calls that name no agent keep working. Migration 9 adds the `agent` column to those records. (#110)
- A task can be addressed to one agent besides its role: `save_task` takes `for_agent` (an agent that may take the task's role, or `null` for any agent with the role), and the task form in the web interface has a "For agent" field. An agent that names itself in `start` sees the role's tasks addressed to it first, then those addressed to nobody, and not those addressed to another agent; `claim_task` by a different named agent is a `conflict`, and a claim records the agent. `start` also returns the agent's own last checkpoint, with `newer_checkpoint_by_another_agent` when another agent of the role wrote a later one. Callers that name no agent see everything, as before. Removing an agent leaves its tasks with the role. A zip export keeps a task's addressee (#146). Migration 10. (#116)
- Owner comments reach the responsible agent in two more places. `start` with a role lists `owner_comments_waiting_on_tasks`: open tasks of the role where the last comment is the owner's (up to 10; an agent's `comment_task` clears it). And the owner can comment on a routine (`target_type: "routine"`, field `item`, no line range): the routine's role sees it in `start` and in `get`, answers with `reply_review_comment`, and the owner resolves it, as with comments on an instruction. The web interface has no form for routine comments yet. (#118)

### Fixed

- An agent's short name (slug) stays with it for good, because the log, checkpoints and claims are recorded under it: it can no longer be changed, and the slug of a removed agent that has history is not given to a new one. A name with no Latin letters or digits (for example in Cyrillic) no longer becomes `agent`, `agent-2`: the owner types a short name, and the form on the Platforms has a field for it. `start` with `agent` lists only the roles that agent can really use. (#141)
- A task addressed to an agent could be claimed by a call that named no agent, from any platform. Only the addressee can claim it now; the owner still can. (#139)
- A document opened from Projects, an older version on the History screen and comments on a task page are rendered as Markdown instead of showing the Markdown source. They use the same built-in renderer as the reading pages. (#124)

### Changed

- The web interface calls a connected AI platform a platform everywhere: the Connections screen is now Platforms (same address, `/connections`), and its texts and the consent screen say "platform". (#147)
- The instruction to paste into a platform and the Grok page tell a bot to pass `agent`, and say how to add agents under a platform. A new page covers connecting any other MCP client. (#145)
- The **Map** lists each role once. The grid of role cards under the tree is gone; a tap on a role in the tree opens its page, which now also has a **Works with** section (declared links and recorded hand-offs in both directions, and who reports to the role). With seven roles the Map on a phone is under three screens instead of seven. "1 open task has no role" is now grammatical. (#134)
- Project and task pages read first, like documents and roles. A project shows its focus, where work stopped, repositories and the description rendered as Markdown; a task shows its status, role, addressee, project, due date, what it waits for, and the description and result rendered as Markdown. The form is behind **Edit**; an item that was just created stays in the form. (#132)
- A role page reads first. It shows the role's area, the agents that take it and their platforms, the instruction rendered as Markdown, its open tasks, its routines and its last checkpoint; the form is behind **Edit**. Each routine has a **Comment** button, so the owner can now comment on a routine in the interface, see the role's answer and resolve it. A role that was just created stays in the form. (#128)
- **Projects and documents** starts with a "Rules and instructions" section: the working rules, other rules sets and every role's instruction, each opening on its reading page. They are still under More as well. (#126)
- The **Map** shows who runs where: at the top, each active platform with its agents and the roles each may take; on every role card, the agents that may take it and their platform. The role cards now follow the order of the tree instead of the alphabet. The tree itself is unchanged. (#122)
- The **Changes** screen groups what happened to one item into one card (a task that was created, assigned and claimed is one card with three lines, oldest first), so the feed is about half as long. Edits to working rules and role instructions still come first, each on its own. On desktop the sidebar is split into the main screens, **Content** and **Settings**. (#120)
- Tool responses are smaller. Every MCP response is compact JSON without indentation. **Breaking for a bot that reads the field:** `start` lists archived roles by slug only (`data.archived_role_slugs` replaces `data.archived_roles`; the slug is what stays reserved, and the conflict error still gives the id), and events in `changes_since_previous_start` leave out fields that are empty. Clients that read `data.archived_roles` must switch to the new field. (#114)
- The brief and decision record 0006 define platforms, agents and roles as three separate things, and the order in which agents are delivered. (#106)
- Decision record 0006 also records how the decision was reached: what the review found, which proposals were withdrawn and why, and what a reviewer should check. (#111)
- Decision record 0006 ends with what was delivered, by issue and pull request, where the result differs from the plan, which existing tests changed and what is not done. README and the architecture page say 18 tools, not 16. (#136)

### Upgrade

- Upgrading from 0.3.1 applies four additive migrations (8–11) automatically, after a pre-migration backup. Existing 0.3.1 data is kept.
- **Breaking:** `start` returns `data.archived_role_slugs` instead of `data.archived_roles`. In `changes_since_previous_start`, empty event fields are omitted. MCP responses are compact JSON (no indentation).
- A bot that passes `agent` acts only in that agent's roles. Migration 8 creates one agent for each confirmed platform+role pair; a platform without a confirmed list gets no agents until the owner adds one.
- Rollback to 0.3.1 is possible only by restoring the pre-migration backup: 0.3.1 will not open a database that 0.4.0 has migrated.

## [0.3.1] - 2026-11-26

### Fixed

- The Map graph is redesigned as a vertical tree of rectangular role cards (full role name and open-task count), so the reporting hierarchy reads top to bottom and fits the screen width on phones (~375–430px) and desktop with no horizontal scrolling of the page or the graph. Cards stretch to the available width; deep trees indent less. Reporting lines run down the left side; declared links (solid) and recorded interactions (dashed) are arrows in a narrow gutter on the right. The biggest real tree comes first, and roles named `[TEST] …` are dashed and placed after every real role, so they no longer become the visible roots that push the team off-screen. The old circle nodes, 14-character labels and fixed 160px column forest are removed. (#102)

## [0.3.0] - 2026-11-26

### Added

- Agents can set or clear the local role label on a mirrored GitHub issue with `set_issue_role` (by id, or by repository and number). Nothing is written to GitHub. The owner can set a default role for newly synced issues of a repository, and a list of roles allowed to assign labels on that repository, on the GitHub screen. Existing issues are left unchanged until someone sets them explicitly.
- A role can have an optional "reports to" parent (`parent_id`). The Map page lays roles out as a reporting tree instead of a circle: solid lines are reporting and declared links, dashed lines are recorded interactions. Node cards list open tasks and routines. Import restores the parent in a second pass, including when the parent was created later; a missing parent, a cycle, a parent from another workspace, or a reporting line whose ancestor depth plus subtree height would exceed 16 is rejected and the import is rolled back. An archived parent is rejected only when the parent actually changes. `save_role` does not run the reporting-line permission check when `parent` is omitted or is `null` and unchanged. Reparenting is rejected when the new parent's ancestor depth plus the height of the moved subtree would exceed 16 levels.
- Review comments on reading pages (`/reviews`, and a pane on `/read/…`): the owner comments on a block, a bot replies with `reply_review_comment`, and the comment can be marked answered or resolved. Comments re-anchor when a new version is saved (exact quote, line map, then a fuzzy window), or become `outdated`. Re-anchoring compares context the way it is stored (including the separating newline), a fuzzy tie picks the hit nearest the old line, and a unique occurrence outside the window is accepted when at least one adjacent line matches; `ctx_after` is stored after a truncated quote, and quotes no longer keep a trailing `\r` on CRLF text. `setup_notes` has an append-only history starting at this upgrade; comments on that field point at a history row. `start` lists the 10 oldest open comments a role is responsible for; `get` and `search` cover `review_comment`. A `review.commented` webhook is sent to every active role with `edit_any` (and to the responsible role for other targets); if there is no such role, nothing is sent. The comments migration is id 6. Re-anchoring stays within the 500 ms write-lock budget even when a short quote repeats through a 200k document. Forbidden status changes write a `role_check` audit row (a `rejected` row is recorded after the transaction so it survives the rollback).
- A Reading section in the owner interface renders working rules, other rules sets, role instructions and setup notes, project descriptions and documents as Markdown (`/read`, `/read/rules`, `/read/rules/:id`, `/read/role/:id`, `/read/project/:id`, `/read/document/:id`, and `?v=N` for an older version). History and compare reuse the existing version APIs. Each edit screen has a Read link, and each reading page has an Edit link. The pages are owner-only; there is no public share route. The default `GET /entity/rules` response now also lists every rules set (`sets`) so the index can group them; there is no new owner route.
- A built-in Markdown parser (`ui/src/markdown.ts`) turns text into Preact elements only. Raw HTML is shown as text, images become links, and only `http`, `https`, `mailto` and same-origin `/` paths are clickable. `scripts/check-tree.sh` fails if the interface uses `innerHTML` or similar insertion APIs.

### Changed

- The Map page no longer uses a circular layout or hides the graph when there are more than 16 roles; the tree scrolls inside its own container.
- Zip export and import include the local GitHub mirror (`github_repo` with `default_role_id`, `github_repo_assigner`, and `github_issue` with its role label) so those settings and labels survive a move. The encrypted GitHub token in `github_config` is still excluded; reconnect GitHub after import. Import rebuilds the search index for those issues (title, body, and `full_name#number`). A workspace that already has a GitHub mirror is not treated as empty, so a second import is refused with the usual conflict message instead of a unique-constraint error. A default role, assigner role, or issue role that is not in the import is rejected with a clear error and rolled back.

### Fixed

- A rejected role check is still recorded in the owner diagnostics after the write transaction is rolled back.
- The Map no longer draws an agent that claimed the role "owner" as the owner; only a real owner session or owner connection is shown as owner.
- In warning mode, `claim_task` with an unknown `claimed_role` and no `role` now proceeds with a warning instead of failing with `not_found`.
- `GET /api/owner/connections` no longer writes a suggested role list. Suggestions are still shown from that connection's history until the owner saves or confirms the list, or turns on enforcement.
- Saving a connection's role list without confirming it now records a log event, including when the list was already empty.
- Import now inserts rows without a parent first and sets parent links in a second pass, so a task whose parent was created later imports successfully. A parent missing from the import or a cycle is rejected as invalid and the import is rolled back.
- The owner change feed now sets `versioned.id` to the rule set's id, so a History link for a named or project rules set opens that set instead of the default working rules.
- Documentation now states that the deprecated `role` synonym on `claim_task` and `checkpoint` is accepted in both warning and enforce modes, and that a connection added after enforcement is on cannot write until the owner confirms its role list.

## [0.2.0] - 2026-11-26

### Added

- Each OAuth connection has an allow-list of roles, set by the owner on the Connections screen. An agent write must name `claimed_role`; the server checks that the role exists, is not archived, and is on that connection's confirmed list. Several bots can share one connection and still sign their edits with their own role names.
- A role may edit items that belong to it. The owner can mark selected roles as allowed to edit any item. The log and the Changes screen show who made a change and whose item it was.
- Role checks start in warning mode after an upgrade: writes still succeed, and the response includes a warning. The owner turns on enforcement from Connections, after confirming each active connection's list (or with an explicit, recorded override). A list suggested from a connection's own history is a draft and has no effect until it is confirmed.
- Projects can have an optional owning role (`owner_role`).
- Multiple titled rules sets per member (`id`, unique `slug`, `title`, optional `project`). Existing `get` / `update_rules` / `start` calls without the new arguments still return or update the default working-rules set. `start` takes an optional `project` and, when given, includes `project_rules` that supplement the global working rules. There is no separate "active" test set: attach a set to a `[TEST]` project instead.
- Routines are a first-class entity: name, owning role, schedule, timezone, status (`enabled` / `paused`), optional external platform id, and last run time and result. `save_routine` creates and updates them; `start` lists all routines and, for a given role, that role's routines; `get` and `search` cover them too. The server stores this information; it does not run the schedule.

### Changed

- `claimed_role` is required on every agent write once enforcement is on, including `save_routine`. On `claim_task` and `checkpoint`, `role` still names the item; using `role` as the author when `claimed_role` is omitted is deprecated and will be removed later. Until then, the old calls are accepted in both warning and enforce modes, checked against the confirmed list, and return a deprecation warning.

### Fixed

- A slug conflict with an archived role now says the existing role is archived and gives its id. `start` lists archived roles separately under `archived_roles`, so the reserved slug is visible without waiting for the error.
- Passing the version-history number (`version`, `working_rules_version`, `instruction_version` or `description_version`) as `rev` now fails with a conflict that names both counters, instead of a generic "changed by someone else" message.

## [0.1.0] - 2026-11-26

The first release.

### Added

- Licensed under AGPL-3.0-only. The web interface (**More**), `/healthz` and the MCP server information link to the source code (`SOURCE_URL`).
- Storage in one SQLite database: working rules, roles with typed links and setup notes, projects, Markdown documents, tasks with hierarchy, dependencies and comments, checkpoints, and the log. Full-text search with FTS5.
- Immutable versions of working rules, role instructions, documents and project descriptions, with line-by-line comparison and rollback.
- A remote MCP server over Streamable HTTP with 15 tools and the `start` entry point. It is stateless, with annotated tools, optimistic concurrency, idempotent creates and atomic task claims.
- A built-in OAuth 2.1 authorization server (better-auth). It supports Client ID Metadata Documents, dynamic client registration and manually created clients, with PKCE S256, resource-bound tokens, rotating refresh tokens, revocation and RFC 9207 `iss`. It also records diagnostics for every authorization step.
- Owner sign-in with passkeys. One-time setup and recovery codes are available only on the host.
- A web interface: map, tasks, projects and documents, changes since the last review, GitHub, log, working rules, connections, webhooks, backups and export, passkeys. It is phone first, with light and dark themes.
- A read-only GitHub issues mirror with role labels.
- Per-role wake-up webhooks, signed and coalesced, with retries, a delivery log and blocking of internal addresses.
- Consistent backups, offline restore, and a backup before every migration. The service refuses to start on a database from a newer release.
- Versioned export to Markdown and JSON with checksums, and import.
- A Docker image for amd64 and arm64 and Docker Compose with an optional Cloudflare Tunnel service.
- A release pipeline: the first `master` push that the release workflow processes while `package.json` names an unreleased version with a changelog section releases that commit. It runs the full CI on it, publishes the tested multi-arch image to GHCR signed with cosign and with SBOM and provenance, moves `latest` only for the highest version, and creates the `vX.Y.Z` tag and a GitHub Release from this changelog. CI and every release also upgrade the previous release's image to the new one with data in place.
- Versions and compatibility rules for 0.x in the README.
- Documentation: deployment, a Raspberry Pi runbook, first-time setup, guides for Claude, ChatGPT and Grok, tools, configuration, webhooks, backups, the security model and architecture.
