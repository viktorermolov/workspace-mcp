# Architecture

Workspace MCP is a modular monolith: one Node.js process, one SQLite file, one container. There are no other services, no queue and no cache. This page explains how the parts fit together, for contributors and for anyone who wants to check what the service does.

## Overview

```text
            AI platforms                          Owner (browser, phone first)
     (Claude, ChatGPT, Grok, …)                              │
                 │ MCP over Streamable HTTP + OAuth 2.1       │ passkey session
                 ▼                                            ▼
 ┌──────────────────────────────── Hono HTTP app (src/web) ───────────────────────────────┐
 │ /mcp ─ token check ─ MCP server (src/mcp)    /api/auth/* (better-auth)    /api/owner/* │
 │                         │                    /.well-known/*                     │      │
 │                         ▼                    /login /consent /setup             ▼      │
 │                 Domain (src/domain): entities, tasks, versions, views ◄── owner API     │
 │                         │      events in the same transaction                           │
 │                         ▼                                                               │
 │            SQLite (node:sqlite, FTS5)  ◄── backups, export, import (src/backup)         │
 │                         │                                                               │
 │     event hooks ──► webhook dispatcher (src/webhooks) ──► receivers (https only)        │
 │     scheduler   ──► GitHub mirror (src/github)       ──► GitHub REST API (GET only)     │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Stack and why

| Part | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 26 (current LTS line), TypeScript run directly by Node's type stripping | No build step for the server, one toolchain. |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server` | Small, standard `Request`/`Response`, works with better-auth and the MCP SDK's web transport. |
| Database | SQLite through the built-in `node:sqlite`, FTS5 for search | One file, no service, no native add-on to compile on ARM. |
| MCP | Official TypeScript SDK `@modelcontextprotocol/server` 2.x | Current stable specification, Streamable HTTP. SDK v2 has no authorization server, so OAuth comes from better-auth (as the SDK examples do). |
| OAuth and passkeys | [better-auth](https://better-auth.com) with its OAuth provider, MCP, CIMD, JWT and passkey plugins | Maintained, covers every RFC the MCP authorization profile needs (PKCE S256, RFC 8414, 9728, 8707, 9207, 7591, 7009, CIMD, rotating refresh tokens) and WebAuthn through SimpleWebAuthn. No hand-written token or crypto code. |
| Validation | Zod 4 | Shared by MCP tool schemas and the owner API. |
| Diff | `diff` | Line-by-line comparison of versions. |
| Export | `fflate` | Zip without native code. |
| Address checks | `ipaddr.js` | Classifying webhook target addresses. |
| Web interface | Preact and Vite, built to static files served by the same process | Small bundle for phones, no CDN. |

## Source layout

| Path | What it does |
| --- | --- |
| `src/main.ts` | Entry point: reads configuration, starts the service, handles `SIGTERM` and `SIGINT` with a graceful shutdown. Exit codes: `2` configuration, `3` database locked, `4` database from a newer release. |
| `src/service.ts` | Opens the database, runs migrations (with a backup first when data exists), wires auth, the HTTP app and background jobs. |
| `src/config.ts` | Environment variables, validation, keys derived from `SECRET_KEY` with HKDF. |
| `src/cli.ts`, `bin/` | Offline administration: version, backups, restore, verify, export, import, recovery code. |
| `src/db/` | Opening the database (WAL, foreign keys, exclusive lock) and the numbered migrations. |
| `src/domain/` | All workspace logic, shared by MCP and the owner API: `entities.ts` (rules, roles, projects, documents, archive, purge), `routines.ts` (scheduled routines), `tasks.ts` (tasks, claims, comments, dependencies, checkpoints), `reviews.ts` (owner review comments, replies, re-anchoring, setup-notes history), `versions.ts` (history, comparison, rollback), `views.ts` (`start`, `get`, `search`, `changes`), `agents.ts` (agents on a platform and their roles), `access.ts` (connection allow-lists, `claimed_role` checks, who may edit what), `core.ts` (ids, limits, events, versions, search index). |
| `src/mcp/` | The MCP server and its 16 tools (`server.ts`), and the `/mcp` endpoint that checks tokens and serves each request statelessly (`endpoint.ts`). |
| `src/auth/` | better-auth setup (`auth.ts`), connections and revocation (`connections.ts`), OAuth diagnostics (`diagnostics.ts`), setup and recovery codes (`setup.ts`). |
| `src/web/` | The HTTP app with security headers and rate limits (`app.ts`), the owner API (`owner-api.ts`) and its read models (`owner-views.ts`). |
| `src/webhooks/` | Per-role wake-up webhooks: queueing, coalescing, signing, retries (`dispatcher.ts`) and the SSRF-safe sender (`transport.ts`). |
| `src/github/` | The read-only issues mirror. |
| `src/backup/` | Consistent backups and restore (`backup.ts`), the export format and import (`export.ts`). |
| `src/util/` | Crypto wrappers over `node:crypto`, the JSON logger, the rate limiter. |
| `ui/` | The web interface (Preact). `ui/src/screens/` holds the screens: map, tasks, projects and documents, changes, GitHub, log, connections, webhooks, backups, sign-in, consent and setup. |
| `test/` | Unit and integration tests (`node:test`), including a real MCP client through OAuth. |
| `e2e/` | Playwright tests of the main interface flows with a virtual passkey. |
| `scripts/` | Container smoke test, a check that the tree has no secrets or personal data. |

## Data model

Every workspace table has a `member_id`. Today there is exactly one member, the owner, created at first start. A second person can be added later without a rewrite; invitations, permissions and data separation are not built.

| Table | Holds |
| --- | --- |
| `member` | The owner (and, later, others). Linked to the better-auth user that holds the passkeys. Holds `role_enforcement` (`warn` or `enforce`). |
| `rules` | The working rules of a member: one versioned text. |
| `role`, `role_link` | Roles with area, instruction (versioned), setup notes, optional webhook, and an optional `parent_id` (the reporting line; a forest of roots). Typed links between roles. A role may be marked `edit_any` by the owner. Existing `reports_to` links are not converted to `parent_id`. |
| `project` (optional `owner_role_id`) | Projects with a versioned description, current state (focus, where work stopped) and repository links. |
| `document` | Markdown documents attached to the workspace, a project or a role; versioned. |
| `version` | Immutable versions of rules, role instructions, project descriptions and documents: number, body, author (connection, claimed role or owner), time, note. |
| `setup_notes_history` | Append-only history of a role's setup notes, written with `saveRole`. Immutable; deleted only under `purge_guard`. History starts at the upgrade that added the table. |
| `review_comment`, `review_reply` | Owner review comments on a versioned field or on setup notes, with original and current anchors (`exact`, `moved`, `outdated`, or `none`), status (`open`, `answered`, `resolved`), and replies. |
| `task`, `task_dependency`, `task_comment` | Tasks with status, role, project, parent, dependencies, priority, due date, result, blocking reason; comments. |
| `checkpoint` | What an agent did, where it stopped and what is next, per role and project. |
| `routine` | A recurring job owned by a role: name, schedule, timezone, status (`enabled` / `paused`), optional external platform id, last run time and result. The server stores this; it does not run the schedule. |
| `event` | The log: who changed what and when. Read by cursor. |
| `idempotency` | Keys that make creates safe to retry. |
| `start_cursor` | Per connection and role, the event id of the previous `start`, for "changes since your last call". |
| `connection`, `connection_role` | OAuth clients the owner approved and named, with last activity and revocation, and the confirmed or suggested list of roles each connection may sign writes as. |
| `agent`, `agent_role` | Named bots on a platform (a connection), each with the roles it may take (decision 0006). Kept by the owner; MCP can read them in `start` and cannot change them. Like connections, they are not part of a zip export (a SQLite backup keeps them); checks on writes still use `connection_role`. |
| `oauth_diag` | Steps of authorization attempts, without secrets. |
| `setup_code` | Hashes of setup and recovery codes. |
| `search_fts` | FTS5 index of titles and bodies. |
| `github_config`, `github_repo`, `github_issue`, `github_repo_assigner` | The encrypted token, selected repositories (optional project, optional default role for newly synced issues, and roles allowed to set the local issue label), and mirrored issues with their role label. A zip export includes `github_repo` (with `default_role_id`), `github_repo_assigner`, and `github_issue` (with the role label), and never includes `github_config` (the encrypted token); reconnect GitHub after a zip import. A SQLite backup copies the whole database, including the token. |
| `webhook`, `webhook_delivery` | Subscriptions with encrypted secrets, and the delivery log. |
| `purge_guard` | A marker row set only inside the owner's permanent deletion, the one place where the version triggers allow deletes. |

better-auth keeps its own tables (users, sessions, passkeys, OAuth clients, tokens, signing keys) in the same database, created by its migrator.

## Key mechanisms

### One transaction per change

Every write in `src/domain` runs in one SQLite transaction that updates the row, adds a version when the item is versioned, remaps open review comments onto the new text, updates the search index, appends to `event`, and queues webhook deliveries through event hooks. Either all of it happens or none does, so the log and history never disagree with the data.

### Versions and conflicts

Versioned bodies live only in `version` rows. Triggers make versions and the `event` log immutable: no statement can update them, and versions can be deleted only inside the owner's permanent deletion of a whole archived item. A rollback appends a new version with the old body. Every mutable row has a `rev`; an update must pass the `rev` it last read, and a mismatch returns `conflict` with the current revision instead of overwriting. Creates accept an idempotency key. `claim_task` is a single conditional update, so two agents cannot both claim one task.

### Hierarchy and dependency cycles

Setting a task's parent or adding a dependency walks the graph inside the same transaction and rejects a change that would close a cycle.

### Stateless MCP

`/mcp` verifies the access token with better-auth (signature, issuer, audience equal to `PUBLIC_URL/mcp`, expiry), checks that the token's connection is still approved, and then serves the request with a fresh MCP server instance and no session. Identity comes from the token on every call, so reconnects and restarts change nothing.

### Instructions and data

`start` returns an `instructions` block (working rules, the rule to save state before finishing, the role's instruction) and a separate `data` block. Tool descriptions and the server's MCP `instructions` say that only the first carries instructions.

### Changes for the owner

The **Changes** screen reads `event` after the owner's last "reviewed" mark and joins version pairs for the line diffs. Edits to working rules and role instructions are sorted first.

### Webhooks

An event hook queues a delivery for each role subscription that matches, inside the change's transaction. A background loop coalesces events of a subscription for a short window into one request, signs it with HMAC-SHA256 over the timestamp and body, sends it with a total deadline per attempt, retries with backoff a limited number of times and records every attempt. See [webhooks.md](webhooks.md).

### GitHub mirror

A scheduler (and the manual refresh) lists issues of the selected repositories with `GET` requests and upserts them into `github_issue`. Nothing is written to GitHub. The role label is the only local field on an issue. A repository may have a default role, applied only when an issue is first inserted, and a list of roles the owner has allowed to change that label (besides the owner and roles marked as allowed to edit any item). Changing the default later does not backfill existing issues.

### Backups, export and import

Backups use SQLite's online backup API, never a file copy of the live database. Restore is offline: the running service holds an exclusive lock on the file, so the CLI refuses to restore or import under it. Before applying migrations to a database with data, the service makes a `pre-migration` backup; a database migrated by a newer release refuses to start on an older one with a clear message. The export is a versioned zip with readable `.md` files, a JSON file with structure, links and full history, and a manifest with checksums. Import inserts rows in table order, then applies self-referential parent links (`task.parent_id` and `role.parent_id`) in a second pass so a child created before its parent still imports; a missing parent, a cycle, or a role reporting line whose ancestor depth plus subtree height would exceed 16 is rejected and the import is rolled back. See [backups.md](backups.md).

### Background jobs

Scheduled backups, the GitHub sync, webhook deliveries and the expiry of unused OAuth clients run on timers inside the process and stop cleanly on shutdown.

## Versions and releases

- The service version comes from `package.json` and is reported by `/healthz`, the MCP server info and `cli version`.
- Migrations are numbered and never edited after release.
- The export format has its own version, checked on import.
- CI (`.github/workflows/ci.yml`) runs typecheck, unit and integration tests, the UI build, the tree check, Playwright e2e, and builds and smoke-tests the image natively on amd64 and arm64 without publishing it.
- The CI image job also upgrades the newest published release to the new image with data in place (`scripts/container-upgrade.sh`): data and sign-ins survive, a schema change runs once after exactly one verified `pre-migration` backup.
- The release workflow (`.github/workflows/release.yml`) runs on every push to `master` and releases that commit when `CHANGELOG.md` has a section for the `package.json` version that is not released yet; otherwise it stops after its guard. It runs the full CI on that commit, builds each architecture with SBOM and provenance, pushes it by digest without a tag, smoke-tests and upgrade-tests exactly that digest, then joins them into one multi-arch image, checks its SBOM and provenance, signs it with cosign (keyless) and only then tags it (`latest` last, only for the highest version), and creates the git tag `vX.Y.Z` and the GitHub Release from the changelog. A version already released or in the registry is never rebuilt.
