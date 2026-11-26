# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Routines are a first-class entity: name, owning role, schedule, timezone, status (`enabled` / `paused`), optional external platform id, and last run time and result. `save_routine` creates and updates them; `start` lists all routines and, for a given role, that role's routines; `get` and `search` cover them too. The server stores this information; it does not run the schedule.
- Multiple titled rules sets per member (`id`, unique `slug`, `title`, optional `project`). Existing `get` / `update_rules` / `start` calls without the new arguments still return or update the default working-rules set. `start` takes an optional `project` and, when given, includes `project_rules` that supplement the global working rules. There is no separate "active" test set: attach a set to a `[TEST]` project instead.

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
