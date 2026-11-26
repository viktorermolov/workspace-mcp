# Workspace MCP

A self-hosted, portable workspace for your AI agents, served as a remote MCP server.

You keep one workspace (working rules, roles, projects, documents, tasks and checkpoints) and connect it to any AI platform that supports remote MCP with OAuth: Claude, ChatGPT, Grok or another client. When you move to a new platform, connect it and say *"This is my workspace, call `start` and continue from there."* Everything the platform changes stays in the workspace for the next one.

The service stores, shows and notifies. It does not run agents, assign work, set priorities or call an LLM: your agents and you decide, the platform executes.

- One instance serves one person. Anyone who wants the same runs their own.
- Open source under the [GNU Affero General Public License v3.0](LICENSE). No paid features, no telemetry, no external services or accounts.
- One Docker container with SQLite. Runs on a Raspberry Pi 4.

> **Status:** pre-release (0.1.0, unreleased). Platform connections are documented from each platform's own documentation and have not yet been confirmed against every platform in production. See [CHANGELOG.md](CHANGELOG.md).

## What it stores

- **Working rules**: how to work with you, shared by every role and platform.
- **Roles**: area of responsibility, instruction, typed links to other roles, an optional wake-up webhook, and setup notes for what a new platform must recreate by hand (schedules, connectors, triggers).
- **Projects**: description, current focus, where work stopped, repositories.
- **Documents**: Markdown of any kind, attached to the workspace, a project or a role, with full-text search.
- **Tasks**: status, role, project, parent, dependencies, priority, due date, result, comments and history. Claiming is atomic; cycles are rejected.
- **Checkpoints**: per role and project, what was done, where it stopped, what comes next.
- **GitHub issues mirror** (optional): a read-only copy of issues from selected repositories, shown next to tasks.
- **Log**: who changed what and when.

## How it works

- **MCP.** One endpoint, `https://<your address>/mcp`, over Streamable HTTP, with 15 tools. The entry tool `start` returns your working rules, the role's instruction, open tasks, the last checkpoint and what changed since the previous call. Everything else is fetched by id. Calls are stateless, so reconnects and restarts change nothing. See [docs/tools.md](docs/tools.md).
- **Agents edit directly, and nothing is lost.** Working rules, role instructions, documents and project descriptions keep every version with its author. Any two versions can be compared line by line, and a rollback is one tap. Agents cannot change history or delete anything permanently.
- **You see what changed.** The **Changes** screen lists everything agents changed since your last visit, with edits to working rules and role instructions first.
- **Sign-in without passwords.** Platforms connect through the service's own OAuth 2.1 server (CIMD, dynamic registration or a client you create, PKCE, resource-bound tokens, rotating refresh tokens). You approve each connection with a passkey and can revoke it at any time. Every step of a connection attempt is recorded for diagnosis.
- **Wake-ups.** A role can have a webhook that signals your agent platform when, for example, a task is assigned to the role. The request carries only ids; the agent reads the content through MCP.
- **Portable.** Consistent backups, and export to a folder of `.md` files with a JSON file of structure, links and full history, which imports back.

## Web interface

Phone first, light and dark themes, served by the same container with no CDN:

- **Map**: roles, their links, open tasks, last checkpoint and activity.
- **Tasks**: a tree with dependencies and the mirrored issues, with filters.
- **Projects and documents**: view and edit, version history, line-by-line comparison, rollback.
- **Changes**: what agents changed since your last visit, with one-tap rollback.
- **GitHub**: connect a read-only token, pick repositories, map them to projects, see sync status.
- **More**: log, working rules, connections with diagnostics, webhooks with their delivery log, backups, export and import, passkeys.

## Quick start

You need Docker with Compose v2 on Linux (`amd64` or `arm64`) and a stable public `https` hostname that forwards to the container, for example through Cloudflare Tunnel, Caddy or nginx.

```sh
git clone https://github.com/viktorermolov/workspace-mcp.git
cd workspace-mcp
cp .env.example .env
# In .env: set PUBLIC_URL=https://<your hostname>, and SECRET_KEY to the output of:
openssl rand -base64 32
docker compose build
docker compose up -d
curl -s http://127.0.0.1:8080/healthz
```

The port is bound to 127.0.0.1 only. If you change `HOST_PORT` in `.env`, use the new port in the `curl` above.

Publish the service at your hostname ([docs/deployment.md](docs/deployment.md)), then open `https://<your hostname>/setup` and enter the one-time code from `docker compose logs workspace` to register your passkey ([docs/first-setup.md](docs/first-setup.md)). Then add `https://<your hostname>/mcp` as a custom connector in your AI platform.

To try it on your own computer before publishing, set `PUBLIC_URL=http://localhost:<port>` (`localhost`, not `127.0.0.1`: passkeys do not work on an IP address) (with the same port as `HOST_PORT`, default 8080) and `TRUST_PROXY=false`, then run `docker compose up -d` again, open `http://localhost:<port>/setup` and enter the code from `docker compose logs workspace`: passkeys work on `localhost`. Agents reach `/mcp` only through OAuth, so `/mcp` answers 401 until a platform or OAuth client signs in. An AI platform on the internet cannot reach `localhost`, so connecting one needs the published hostname. The trial passkey works only on `localhost`, and the trial owner stays in the data volume, so no new setup code is printed after you switch `PUBLIC_URL` to your hostname. Either start from an empty workspace with `docker compose down -v` (this deletes everything stored in the trial), or keep the data and sign in on the new hostname with a recovery code ([docs/first-setup.md](docs/first-setup.md#if-you-lose-your-passkey)).

To have an agent deploy it on a Raspberry Pi for you, give it the [Raspberry Pi runbook](docs/runbook-raspberry-pi.md).

## Documentation

| Topic | Page |
| --- | --- |
| Deploying, publishing over https, updating and rolling back | [docs/deployment.md](docs/deployment.md) |
| Step-by-step deployment on a Raspberry Pi with Cloudflare Tunnel (for an agent) | [docs/runbook-raspberry-pi.md](docs/runbook-raspberry-pi.md) |
| First-time setup for the owner | [docs/first-setup.md](docs/first-setup.md) |
| Connecting Claude, ChatGPT and Grok | [Claude](docs/platforms/claude.md), [ChatGPT](docs/platforms/chatgpt.md), [Grok](docs/platforms/grok.md) |
| An instruction to paste into any platform | [docs/agent-instruction.md](docs/agent-instruction.md) |
| MCP tools | [docs/tools.md](docs/tools.md) |
| Configuration and limits | [docs/configuration.md](docs/configuration.md) |
| Webhooks | [docs/webhooks.md](docs/webhooks.md) |
| Backups, restore, export and import | [docs/backups.md](docs/backups.md) |
| Security model and threat model | [docs/security.md](docs/security.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |

## What it does not do

Run or schedule agents, call an LLM, embeddings or vector search, store files or secrets, multiple users with permissions, bearer API keys, writing to GitHub, or a public REST API.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Viktor Ermolov.

Workspace MCP is free software under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). You may use it for any purpose, including commercially, and change it. Sharing copies (including container images) or running a modified version as a service for others comes with the license's conditions: among them, you must offer the source code under the same license. For a modified service, set `SOURCE_URL` to where your source is ([configuration](docs/configuration.md#source-code-agpl)). Third-party dependencies keep their own licenses.
