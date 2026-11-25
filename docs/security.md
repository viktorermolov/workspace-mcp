# Security model

This page describes what Workspace MCP protects, against whom, and where its protection ends. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What the service is

One instance serves one owner. It stores text (working rules, role instructions, projects, documents, tasks, checkpoints) and shows it to the owner's AI platforms over MCP and to the owner in a web interface. It runs no agents, calls no LLM, executes nothing it stores and gives no access to the host's file system or a shell.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Workspace content | SQLite database in the data volume | Private notes, plans and instructions of the owner. |
| Working rules and role instructions | Same database, versioned | Every later agent session follows them. A malicious edit changes how agents behave. |
| OAuth tokens | Refresh tokens: database, stored as hashes. Access tokens: short-lived signed JWTs, not stored | Give a platform read and write access to the whole workspace. |
| Owner passkey | The owner's device; the server keeps only the public key | Opens the web interface and approves new connections. |
| `SECRET_KEY` | `.env` on the host | Signs owner sessions and encrypts the GitHub token and webhook secrets. |
| GitHub token, webhook authorization values and signing secrets | Database, encrypted | Read access to the owner's issues; the right to wake the owner's agents. |
| Setup and recovery codes | Service log (setup) or terminal (recovery); the server keeps a hash | Whoever uses a valid code first registers a passkey for the owner. |

## Trust boundaries

1. **The internet to the service.** Everything except `/healthz`, OAuth discovery documents and the sign-in pages needs either an OAuth access token (MCP) or the owner's session (web interface).
2. **A connected platform to the workspace.** A connection can read and change all content. It cannot manage connections, webhooks, GitHub, backups or the owner account, cannot delete anything permanently and cannot change version history or the log.
3. **Text inside the workspace to the agents that read it.** Content is written by agents and, through the issues mirror, by anyone who can open an issue in a mirrored repository. It is data, not instructions.
4. **The service to the outside.** The service makes outbound requests only to fetch client metadata documents (CIMD), to deliver webhooks, and to the GitHub API when the owner connected it.
5. **The host to the service.** Whoever controls the host or the container controls the workspace. The service does not defend against its own operator.

## Design decisions

### A role is a label, not a security boundary

An agent claims its role itself (`claimed_role`). Executors under one connection are indistinguishable to the server, so every connection sees and can change the whole workspace. Roles organise work; they do not restrict it. Revoke a connection to cut a platform off.

### Agents change content directly, and every change is reversible

Agents do not need the owner's approval to edit. Instead:

- Working rules, role instructions, documents and project descriptions are versioned. Every change creates a new immutable version with its author (connection and claimed role, or the owner), time and note.
- A rollback creates a new version. Nothing is erased.
- No MCP tool changes or deletes a version or a log entry.
- The **Changes** screen lists everything the owner has not reviewed yet, with edits to working rules and role instructions first, because they change the behaviour of every later session.

### Instructions and data are kept apart

Only the `instructions` block returned by `start` carries instructions. The server's MCP `instructions`, the description of `start` and the working rules it returns tell agents that text in tasks, documents, comments, checkpoints and issues is data that never changes rules or access. This reduces, but cannot remove, the risk of prompt injection: whether an agent obeys text it reads is decided by the platform and the model, not by this server. The protection that does not depend on the model is that injected text cannot reach anything outside the workspace through this server, and every change it causes is recorded and reversible.

### What MCP cannot do

- Manage connections, OAuth clients, webhooks, the GitHub token, backups, export, import or the owner account.
- Delete anything permanently. Agents can only archive; permanent deletion is an owner action in the web interface, offered only for archived items.
- Change or delete version history or the log.
- Read files, run commands or execute code on the host.

### The workspace is not a secrets store

The working rules returned by `start` tell agents not to write passwords, keys or tokens into the workspace. Content is stored in plain text in the database, is visible to every connection and is included in exports.

## Authentication

### Platforms: built-in OAuth 2.1 server

The only way in for platforms is the service's own OAuth 2.1 authorization server. There are no bearer keys and no external identity providers. It is built on [better-auth](https://better-auth.com) and its OAuth provider, MCP, CIMD and passkey plugins, a maintained library with the MCP authorization profile implemented and tested. No token or cryptographic logic is written by hand.

- Discovery: Protected Resource Metadata (RFC 9728) and authorization server metadata (RFC 8414). The `401` from `/mcp` points to the resource metadata in `WWW-Authenticate`.
- PKCE with `S256` is required.
- Clients register through Client ID Metadata Documents, dynamic client registration (RFC 7591), or as clients the owner creates by hand in the web interface.
- Authorization responses carry `iss` (RFC 9207).
- Access tokens are bound to the resource `PUBLIC_URL/mcp` (RFC 8707). A token issued for another resource is rejected.
- Access tokens live one hour by default (`ACCESS_TOKEN_TTL_SECONDS`). Refresh tokens rotate on every use and expire after 60 days without use. Revocation (RFC 7009) is supported.
- Access tokens are short-lived JWTs signed with a key that better-auth stores encrypted. Refresh tokens are stored only as hashes. A copy of the database does not contain usable tokens.
- Every MCP request also checks that the token's connection is still approved, so revocation takes effect at once even though access tokens are self-contained.
- Dynamic registration cannot register `client_credentials` clients: every connection needs the owner's approval on the consent screen.
- Clients registered dynamically that never complete a connection are removed after `UNUSED_CLIENT_TTL_DAYS`.
- **Revoke** on the Connections screen marks the connection revoked and drops its grants in one transaction; every later request with its tokens gets `401`.

### The owner: passkeys only

- The owner signs in with a passkey (WebAuthn). There is no password and no email sign-in. The same sign-in opens the web interface and the OAuth consent screen.
- The passkey's relying party is the host name of `PUBLIC_URL`, so a passkey only works on that address. Changing `PUBLIC_URL` invalidates it.
- The owner session lasts 30 days and is renewed daily while used. Cookies are `Secure` when `PUBLIC_URL` uses `https`.
- Every owner API call needs the session. Every change must also come from the service's own origin (`Origin`, or `Sec-Fetch-Site: same-origin`), which blocks cross-site request forgery.

### First-time setup and recovery are local

- The first passkey is registered with a one-time setup code that the service prints to its own log at start while no owner passkey exists. Only someone with access to the host's logs can read it.
- A lost passkey is replaced with a recovery code from `cli recovery-code`, run inside the container. It needs shell access to the host.
- Codes have 80 bits of entropy, are stored as hashes, work once and expire after 30 minutes. Attempts are limited to 10 per minute per client address.

**Exposure.** Between start and the owner's first registration, anyone who reads the log can take the instance. Keep the logs private and complete setup soon after deployment. Once a passkey exists, no setup code is printed.

## Outbound requests and SSRF

The service fetches addresses that someone else supplies in two places. Both refuse internal addresses by default:

- **Client ID Metadata Documents.** The client ID URL must be `https` on a public host. The fetcher, from better-auth, resolves the host itself and refuses hosts that resolve to loopback, private, link-local or other reserved addresses. Redirects are not followed.
- **Webhooks.** The owner configures the URL, but the same rule applies so that a mistaken or hostile URL cannot reach the host's network. URLs must use `https` and must not embed credentials. The address is checked inside the socket's own DNS lookup, so the connection goes to exactly the address that was checked (no DNS rebinding). Redirects are not followed. `WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true` lifts the rule for receivers on your own network.

The GitHub API base is fixed by configuration (`GITHUB_API_URL`).

## Secrets at rest

- `SECRET_KEY` is never stored. Two independent keys are derived from it with HKDF-SHA256: one signs sessions, the other encrypts the GitHub token, webhook authorization values and webhook signing secrets with AES-256-GCM.
- Without `SECRET_KEY`, a copy of the database exposes the workspace content but not these secrets, the token signing key or usable tokens.
- Backups contain the database, so they contain content in plain text and secrets in encrypted form. Store backups as carefully as the live data.
- Exports never contain secrets, tokens, passkeys, connections or webhooks.

## Abuse limits

| What | Limit |
| --- | --- |
| MCP requests | 600 per minute per client address |
| MCP request body | 1 MiB, including chunked bodies |
| MCP response | 512 KiB; larger results ask for a narrower request |
| Client registration | 30 per hour per client address |
| Token requests | 60 per minute per client address |
| Passkey sign-in / registration | 20 / 10 per minute per client address |
| Setup and recovery codes | 10 attempts per minute per client address |
| Owner API body | 2 MiB (import: 100 MB) |

Every input is validated against a schema with length limits ([configuration.md](configuration.md#fixed-limits)). All SQL is parameterised.

Rate limits are per client address and are kept in memory, so they reset on restart. **Behind a proxy or tunnel, set `TRUST_PROXY=true`**, or every client shares the proxy's address and one noisy client limits all of them. Do not set it when clients can reach the port directly: the client address is then taken from `CF-Connecting-IP` or the last `X-Forwarded-For` entry, which a direct client could forge to dodge the limits.

## Web interface

- All assets are served by the service itself. No CDN, fonts or scripts from other origins.
- Content Security Policy: `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`.
- Also set: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`, and `Strict-Transport-Security` when `PUBLIC_URL` uses `https`.
- Stored text, Markdown included, is shown as plain text through the interface framework's escaping. It is never inserted as HTML, so it cannot inject script into the interface.
- Pages carry `noindex, nofollow`.

## Logging, audit and privacy

- Logs are JSON lines on stdout. They never contain tokens, codes, secrets or workspace content.
- The audit trail is in the database: the log of changes (who, what, when), version history, webhook deliveries and OAuth diagnostics. OAuth diagnostics record each step of an authorization attempt without tokens, codes or secrets.
- There is no telemetry and no call to any service the owner did not configure.

## Threat model

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Someone on the internet calls `/mcp` without a token or with a stolen expired one | Every call needs a valid, unexpired, resource-bound token from an approved connection; refresh tokens are hashed at rest | A token stolen while valid works until it expires or the connection is revoked. |
| A platform account of the owner is compromised | Revoke the connection; review and roll back its changes on **Changes** | The attacker can read the whole workspace until revoked. |
| A malicious client registers and asks for access | Registration is rate limited; the owner must sign in with a passkey and approve on the consent screen, which shows the client name and redirect address | An owner who approves a look-alike client gives it access. Check the redirect address. |
| Prompt injection through a task, document, comment or mirrored issue | Instructions and data are separated in every response and the rules say content is data; no tool reaches outside the workspace; every change is logged and reversible | An agent may still follow injected text within the workspace. Review **Changes**, especially edits to rules and instructions. |
| An agent damages or wipes content | Versions are immutable, rollback is one tap, MCP cannot delete permanently or edit history | Archived items and non-versioned fields (task status, comments) are restored by hand from the log or a backup. |
| Cross-site request forgery against the owner session | Same-origin check on every owner change; `SameSite=Lax` session cookies; `frame-ancestors 'none'` | None known. |
| Script injection into the web interface | Strict CSP without inline scripts; stored text is never rendered as HTML | None known. |
| SSRF through a webhook or a client metadata URL | `https` only, internal addresses refused at connection time, no redirects | Opt-in `WEBHOOK_ALLOW_PRIVATE_ADDRESSES` removes the webhook check. |
| Brute force of the setup or recovery code | 80-bit codes, 30-minute lifetime, one use, 10 attempts per minute | Before first setup, anyone who reads the logs can take the instance. |
| Theft of the database or a backup | Refresh tokens hashed; the token signing key and secrets encrypted with keys that are not stored | Workspace content is readable in plain text. |
| Loss of `SECRET_KEY` | Documented; keep a copy in a password manager | Encrypted secrets become unreadable; reconnect GitHub and re-enter webhook values. |
| A webhook receiver or the GitHub API is slow or down | Timeouts, limited retries with backoff, delivery log, coalescing | None to the workspace. |
| Request floods | Per-address rate limits and size limits | Limits are in memory and per process; use the proxy or tunnel for real DDoS protection. |
| The host or container is compromised | Out of scope: non-root user, no shell through MCP | Full compromise of the workspace. |

## Out of scope

Protection against the operator of the host, multi-user access control, and network-level DDoS protection. Use your proxy or tunnel for the last one.
