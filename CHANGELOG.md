# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Version 0.1.0, the first complete version, not yet released.
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
- Documentation: deployment, a Raspberry Pi runbook, first-time setup, guides for Claude, ChatGPT and Grok, tools, configuration, webhooks, backups, the security model and architecture.
