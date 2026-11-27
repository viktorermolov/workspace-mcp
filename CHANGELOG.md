# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The brief and decision record 0006 define platforms, agents and roles as three separate things, and the order in which agents are delivered. (#106)

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
