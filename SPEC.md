# Portable workspace for AI agents (MCP): implementation brief

Name: Workspace MCP (confirmed by the owner on 2026-11-26, before the first release).

## 1. Task and context

Design the details and fully implement a self-hosted service that stores the workspace of one person and their AI agents and connects to any AI platform as a remote MCP server.

The owner periodically changes their main AI platform (Claude, ChatGPT, Grok) and each time moves agent instructions, open tasks and project state by hand. On every platform they build the same setup: an entry agent distributes work between roles (development, promotion, personal assistant and others). The goal: on a new platform it is enough to connect this service and say "this is my workspace, continue from here", and everything the platform changes stays in the service for the next one.

Boundary of responsibility: the service stores, shows and notifies. It does not run agents, assign executors, set priorities or call an LLM. Agents and the owner decide, the platform executes.

The owner also uses the service as the one place to see and steer the agents on every platform: each agent's instruction, tasks and routines, who works with whom, and the owner's comments on any of them. Three things are distinct (decision record [0006](docs/decisions/0006-platforms-agents-roles.md)):

- A **platform** is a connection the owner approved (for example Grok, or an agent on a home server).
- An **agent** is a named bot on one platform. One platform can host many agents.
- A **role** is a function with an instruction (for example coordinator or developer). Several agents on different platforms can take the same role, and one agent can take different roles for different tasks.

## 2. Product format

- Open source under AGPL-3.0-only (the owner's choice, replacing Apache-2.0 before the first release), no paid features, no telemetry, no required external services or accounts.
- One instance serves one owner. Anyone who wants the same runs their own.
- The data model has a member from day one and every record belongs to one, so a second person can be added later without a rewrite. Invitations, permissions and data separation are not built now.

## 3. What the service stores

- **Working rules.** How to work with the owner, shared by all roles and platforms.
- **Roles.** Name, area of responsibility, instruction, typed links to other roles (the link type is free-form), optional wake-up webhook, and setup notes: what has to be recreated by hand on a new platform (schedules, connectors, wake-up triggers), because the service cannot move those.
- **Projects.** Description, current state (focus, where work stopped), links to repositories.
- **Documents.** Markdown of any kind (decision, research, note), attached to the workspace, a project or a role, with versions and full-text search.
- **Tasks.** Title, description, status (open, in_progress, blocked, in_review, done, cancelled), role, project, parent, dependencies, priority, due date, result, comments, blocking reason, history. Cycles in the hierarchy and in dependencies are rejected.
- **GitHub issues mirror.** Read-only, one-way sync from configured repositories (a repository is mapped to a project). Issues are shown next to tasks. The only local addition is a role label. The service writes nothing to GitHub. The feature is optional and off until GitHub is connected. Connecting happens in the web interface: the owner pastes a fine-grained token with read-only access to issues, the service validates it and lists the available repositories, the owner picks the ones needed and maps them to projects. The same screen shows the time and result of the last sync, a manual refresh button, token replacement and disconnect.
- **Checkpoints.** An agent's record per role and project: what was done, where it stopped, what is next.
- **Log.** Who (connection and claimed role, or the owner) changed what and when. Read by cursor.
- **Platforms.** The AI platforms the owner has granted access to (each is one connection), with the agents on each.
- **Agents.** Named bots on a platform, each with the roles it may take.

Storage decisions:

- SQLite is the single source of truth, including Markdown text and all its versions (versions are immutable). There is no parallel tree of .md files: real .md files appear on export.
- Search: SQLite FTS5, local, no LLM and no embeddings.
- Concurrent edits: record version, a clear error on conflict instead of a silent overwrite. Creating operations are idempotent by key. Claiming a task is atomic.
- A change and its event are written in one transaction.

## 4. Trust and versions

- Agents change all content immediately, without owner approval: working rules, role instructions and role structure, documents, projects, tasks.
- Working rules, role instructions, documents and project descriptions are versioned: every change creates a new immutable version with its author (connection and claimed role, or the owner), time and an optional note.
- Any two versions can be compared, with changes shown line by line (what was added, what was removed). A rollback creates a new version and erases nothing.
- An agent cannot change or delete version history or the log.
- Changes the owner has not reviewed yet are marked in the web interface. Edits to working rules and role instructions are highlighted separately, because they change the behaviour of every later session.
- MCP responses clearly separate instructions from other content. Text in tasks, documents, comments and issues is data and cannot change rules or access.
- An agent's name and its role are what the caller says they are: the server can verify only the platform (the connection). It checks the name and role against the lists the owner keeps, which protects against mistakes and mix-ups, not against a hostile agent. Every connection sees the whole workspace.
- Not available through MCP: managing connections, webhooks and secrets, the owner account, permanent deletion (an agent can only archive).
- MCP gives no access to the host file system, a shell or code execution.
- The workspace is not a secrets store. The working rules returned by the entry point tell agents not to write passwords, keys or tokens into it.

## 5. MCP interface

- Streamable HTTP transport, the current stable MCP specification, the current official TypeScript SDK.
- All important functionality is available through Tools, because clients differ in how they support the other parts of MCP.
- About 15 tools at most, with short descriptions. You design the exact set and schemas and document them.
- A single entry point (tentatively `start`, with an optional role). It returns, compactly: the working rules, the rule to save state before finishing, the list of roles, projects with their current focus, and for the given role its instruction, open tasks, last checkpoint and changes since the previous call. The agent fetches the rest by identifier.
- A platform that has just been connected knows nothing about the workspace, so the server's MCP `instructions` and the entry tool's description tell the client to call the entry point first.
- On an empty workspace the entry point says so and explains how to fill it. First fill is done by an agent through MCP (roles, working rules, projects, documents, tasks) or by the owner in the web interface.
- Nothing depends on MCP session state: identity comes from the token, and every call works after a reconnect or a server restart.
- Tools carry correct annotations (read-only, destructive, idempotent), so platforms do not ask the owner to confirm plain reads.
- Required capabilities: get by identifier, search, create, update and archive roles and projects, create and update tasks, atomic task claim, comments and result, create and update documents, update working rules and role instructions, version history and comparison, rollback to a version, write a checkpoint, changes by cursor.
- Pagination and size limits on every list and response.

## 6. Authentication

- The only way in for platforms is the service's own built-in OAuth 2.1 authorization server. No bearer keys and no external providers.
- Compliance with the authorization part of the MCP specification: Protected Resource Metadata (RFC 9728), authorization server metadata (RFC 8414), PKCE S256, client registration through Client ID Metadata Documents and Dynamic Client Registration, the `iss` parameter (RFC 9207), binding of the token to the resource, refresh tokens with rotation, revocation.
- The owner signs in with a passkey (WebAuthn). The same sign-in opens the web interface and the OAuth consent screen.
- On the consent screen the owner approves the connection and names it. The interface lists connections with last activity and a revoke button.
- First-time setup and access recovery are local only (a one-time code in the container logs or a command inside the container).
- The OAuth protocol part and WebAuthn come from mature, maintained libraries; justify the choice. No hand-written cryptography and no hand-written token logic.
- Tokens are stored as hashes. Client registration is rate limited, unused clients expire.
- The public base URL is a required setting. The OAuth issuer and the passkey are bound to it; the documentation states that changing it invalidates existing connections and passkeys.
- OAuth diagnostics: each step of an authorization attempt (discovery, registration, authorization, token exchange, refresh) is recorded without secrets and shown in the web interface. Real platforms can only be connected by the owner, and this is how a failed connection gets diagnosed.

Checked against documentation on 25 November 2026, re-check before implementing:

- MCP specification 2026-07-28: CIMD is recommended, DCR is marked deprecated and kept for compatibility. https://modelcontextprotocol.io/specification/latest/basic/authorization
- TypeScript SDK v2: authorization server helpers were removed from the core, a separate OAuth library is required; the SDK examples use better-auth. https://github.com/modelcontextprotocol/typescript-sdk
- One candidate that covers the list above, not a mandate: the better-auth OAuth 2.1 Provider plugin documents PKCE S256, DCR, rotating refresh tokens issued with `offline_access`, RFC 8707, RFC 9207, RFC 9728 and CIMD, and better-auth has a passkey plugin. https://better-auth.com/docs/plugins/oauth-provider
- Claude: uses CIMD and falls back to DCR when it is missing; callback URL `https://claude.ai/api/mcp/auth_callback` (and the same path on claude.com). https://claude.com/docs/connectors/building/authentication
- ChatGPT: prefers CIMD, also supports DCR and a predefined client, PKCE S256, RFC 9207. https://developers.openai.com/apps-sdk/build/auth
- Grok: custom connector by URL, the server must be reachable from the public internet, authorization is completed while connecting. The documentation does not say how Grok registers its OAuth client (CIMD, DCR or manually): find out and record it. https://docs.x.ai/grok/connectors

## 7. Web interface

- Same process and same container. Owner only. Interface assets are served locally, no CDN.
- Phone first. Dark and light themes.
- Screens:
  - **Map.** Roles as nodes: area of responsibility, links between roles, open tasks, last checkpoint and time of activity. Interactions are built from recorded data (who gave a task to whom, comments, checkpoints). Age is shown by record time and is not presented as real-time status.
  - **Tasks.** A tree with dependencies, together with the issues mirror. Filters by project, role and status.
  - **Projects and documents.** View, version history, line-by-line comparison, rollback.
  - **Changes.** A feed of what agents changed since the owner's last visit: who, when, what exactly (line by line), with one-tap rollback. Edits to working rules and role instructions come first.
  - **GitHub.** Connecting, choosing repositories, mapping to projects, sync status.
  - **Log, connections, webhooks with delivery log, export and backups.**
- The owner can edit tasks, documents and roles directly in the interface.
- The interface works through internal endpoints under the owner session. There is no public REST API.

## 8. Webhooks

- Off by default. Configured only by the owner in the interface, per role: URL, Authorization header value, selected events (for example, a task was assigned to the role).
- The request carries only a signal: event identifier and type, role identifier, time. The agent fetches the content itself through MCP.
- Request signature and timestamp, coalescing of frequent events into one wake-up, limited retries with backoff, timeout, delivery log, ability to disable a subscription.
- Internal and private addresses are blocked by default and allowed only by explicit configuration.
- Webhook secrets and the GitHub token are stored encrypted, the key is set through an environment variable.
- One known receiver, checked on 25 November 2026: a Grok Bot routine with a webhook trigger accepts an HTTP POST with `Authorization: Bearer <key>` and an optional JSON body, and answers 200 when a run has started. Each routine runs at most 200 times an hour. https://cursor.com/help/grok-bot/routines

## 9. Portability and backups

- A consistent backup using SQLite's own mechanism (not a copy of the live file) and restore from it.
- Export in an open format: a folder of .md files with metadata (opens in Obsidian and any editor) plus JSON with structure, links and history. The format is versioned, with an integrity check and import.
- Secrets and live tokens are never included in an export.

## 10. Deployment

- Stack: TypeScript, current Node.js LTS, SQLite. One Docker container with no additional services, a modular monolith.
- Non-root user, persistent volume, health check, configuration through environment variables, graceful shutdown, automatic migrations with a backup before them.
- Images for ARM64 and AMD64. The resource target is a Raspberry Pi 4.
- Listens on the local address only by default. Publishing over HTTPS through a reverse proxy or a tunnel is described in the documentation.
- The first real deployment is on the owner's Raspberry Pi and is carried out by another agent with shell access to it, not by you and not by the owner by hand. Write a deployment runbook for that reader: exact commands, the expected result after each step, how to verify the running service, how to update and how to roll back. Reference path: Raspberry Pi (ARM64), Docker Compose, a tunnel with a stable public hostname (Cloudflare Tunnel as the worked example).
- Deployment from this repository alone must work: building the image on the Pi from source, with no dependency on a published image or package.
- First-time setup after deployment is described separately for the owner: opening the public URL, entering the one-time setup code, registering the passkey, connecting the first platform.

## 11. Baseline security

Validation of all input, parameterized SQL, request size and rate limits, logging without tokens or content, audit of significant operations. The documentation must include a threat model.

## 12. Repository and quality

- Repository: `viktorermolov/workspace-mcp` (already exists, public, default branch `master`). Do not touch the owner's other repositories and services.
- The repository is public from the first commit, so nothing personal goes into it: no real data of the owner, no secrets, no real tokens in tests, examples or fixtures.
- The owner's common dev standard applies (`viktorermolov/dev-standards`, file STANDARDS.md, if you have access). Its main points: all changes go through a PR, no direct commits to the default branch and no force pushes; never weaken your own checks; GitHub Actions on Linux runners only, with timeouts; English on GitHub.
- You merge your own PRs when CI is green.
- The multi-architecture image build runs only on release.
- Tests must check real behaviour:
  - the full path of a real MCP client through OAuth to a tool call;
  - first fill: starting from an empty workspace, a client creates roles, working rules, a project, documents and tasks through MCP only;
  - the main scenario: connection A creates a task and a checkpoint, connection B calls the entry point and continues from the same place, and after A is revoked B keeps working;
  - access without a token and with a revoked token;
  - versions: every change creates a version, comparison shows the exact difference, rollback restores the earlier text, history cannot be changed through MCP;
  - concurrent task claim and version conflict;
  - migrations;
  - backup and restore, export and import;
  - an unreachable webhook URL;
  - container restart without loss of state.
- If your environment has no Docker, the container tests run in GitHub Actions.
- Documentation in English: README, architecture, security model, deployment, tools and configuration reference, backup, connection guides for Claude, ChatGPT and Grok, a universal instruction for an agent. Plus LICENSE, CONTRIBUTING, SECURITY, CHANGELOG.
- Support for a platform may be claimed only after checking its documentation or a real connection. Real connections from the platforms are made by the owner after deployment; that is the final acceptance. Defects found there come back as issues in this repository.

## 13. Out of scope

Orchestration and running of agents, schedules, LLM calls, embeddings and vector search, binary files and attachments (links only), secrets storage, multiple users with permissions and invitations, bearer keys, writing to GitHub, a public REST API, PostgreSQL, Redis, message brokers, microservices.

## 14. Delivery order and stop points

Each stage ends with a working state in the default branch:

1. Core: storage, OAuth, MCP with the entry point, running in Docker, end-to-end test.
2. Web interface.
3. Issues mirror and webhooks.
4. Backups and export, documentation, release preparation.

You make reversible technical decisions yourself and do not stop after a plan or a scaffold.

The result of this task is the complete, finished product, not a core to be extended later. The stages are an order of work, not points of delivery: nothing in this brief is optional and nothing is left for a follow-up. The work is done when all of the following hold in the default branch:

- every part of this brief is implemented: storage, the MCP interface, built-in OAuth with passkey sign-in, the web interface with all listed screens, the GitHub issues mirror, webhooks, versions with comparison and rollback, backup, export and import;
- every test listed in section 12 exists and passes in CI;
- the ARM64 image builds in CI and passes a smoke test: the container starts, first-time setup completes, a client goes through OAuth and calls the entry point;
- an agent with shell access to a Raspberry Pi and nothing but this repository can deploy the service by following the runbook;
- the documentation listed in section 12 is written and matches what the code does;
- the final report states what was verified and how, and lists separately what could not be verified without real platforms.

Stop and ask the owner before you:

- rename the repository or choose the final product name;
- publish images, packages or a release;
- spend money;
- deploy the service to the owner's servers or change their existing services and repositories;
- change the concept: add something from "Out of scope" or remove something agreed.

Final report: what is implemented, what is verified and how, what is not verified, known limitations, deployment instructions.
