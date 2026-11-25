# Configuration

Workspace MCP reads its settings from environment variables once, at start. With Docker Compose they come from the `.env` file next to `compose.yaml` (start from `.env.example`). An invalid value stops the service with `Configuration error: …` and exit code 2.

## Required

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | The public address of the service, for example `https://workspace.example.com`. It must use `https`; `http` is allowed only for `localhost`, `127.0.0.1` and `[::1]`. No path, query, fragment or credentials: the service is served at the root of its own hostname. The MCP endpoint is `PUBLIC_URL` + `/mcp`. |
| `SECRET_KEY` | At least 32 random bytes, base64-encoded. Generate it with `openssl rand -base64 32`. Two independent keys are derived from it with HKDF-SHA256: one signs sessions, the other encrypts the stored GitHub token and webhook secrets (AES-256-GCM). |

### What is bound to these two values

- **`PUBLIC_URL`** is the OAuth issuer, the MCP resource that every access token is bound to, and the WebAuthn relying party of the owner passkey. **Changing it invalidates every existing connection and every passkey.** After a change, register a new passkey with a recovery code (`cli recovery-code`) and reconnect each AI platform.
- **`SECRET_KEY`** must stay the same for the life of the instance. Changing it signs the owner out and makes the stored GitHub token and webhook secrets unreadable (reconnect GitHub and re-enter webhook authorization values). Keep a copy somewhere safe: backups and exports do not contain it, and a restored backup is only fully usable with the same key.

## Optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `./data` (`/data` in the image) | Directory for the database (`workspace.sqlite`) and the `backups/` folder. |
| `HOST` | `127.0.0.1` | Listen address. The image sets `0.0.0.0` inside the container; `compose.yaml` publishes the port on `127.0.0.1` of the host only. |
| `PORT` | `8080` | Listen port. |
| `TRUST_PROXY` | `false` | Set to `true` when the service is reached only through one reverse proxy or tunnel. The client address used for rate limits and diagnostics is then taken from `CF-Connecting-IP`, or else from the last entry of `X-Forwarded-For`. Leave it `false` when clients can reach the port directly, because they could set these headers themselves. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout and never contain tokens, codes or workspace content. |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups, `0` to `720`. `0` turns scheduled backups off. |
| `BACKUP_KEEP` | `14` | Number of scheduled and manual backups to keep, `1` to `1000`. Pre-migration backups are kept separately. |
| `GITHUB_SYNC_INTERVAL_MINUTES` | `15` | Minutes between GitHub issue syncs, `0` to `1440`. `0` keeps only the manual refresh. Has no effect until GitHub is connected in the web interface. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST API base. Change it only for GitHub Enterprise Server. |
| `WEBHOOK_ALLOW_PRIVATE_ADDRESSES` | `false` | Allow webhooks to loopback, private, link-local and other non-public addresses. Keep it off unless the receiver really runs on your own network. |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | Lifetime of an access token, `60` to `86400`. Platforms renew it with a refresh token that is replaced on every use; an unused refresh token expires after 60 days. |
| `UNUSED_CLIENT_TTL_DAYS` | `7` | Dynamically registered OAuth clients that never completed a connection are removed after this many days, `1` to `365`. |
| `UI_DIR` | `dist/ui` next to the source (`/app/dist/ui` in the image) | Location of the built web interface. |

## Compose-only variables

These are read by `compose.yaml`, not by the service.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST_PORT` | `8080` | Port on `127.0.0.1` of the host where the service is published. |
| `WORKSPACE_IMAGE` | `workspace-mcp:local` | Image name. `docker compose build` builds it from this repository. |
| `CLOUDFLARED_TOKEN` | empty | Token of a Cloudflare Tunnel, used only by the optional `cloudflared` service (`--profile tunnel`). |
| `CLOUDFLARED_IMAGE` | `cloudflare/cloudflared:latest` | Image of the optional tunnel service. Pin a version tag here if you want controlled updates. |

## Fixed limits

These are not configurable.

| Limit | Value |
| --- | --- |
| MCP request body | 1 MiB |
| MCP response | 512 KiB of JSON; larger results ask the client to paginate or fetch by id |
| MCP requests | 600 per minute per client address |
| Setup and recovery code attempts | 10 per minute per client address; a code is valid for 30 minutes and works once |
| OAuth client registration | 30 per hour per client address |
| OAuth token requests | 60 per minute per client address |
| Owner web API body | 2 MiB (export import: 100 MB) |
| Titles | 300 characters |
| Short text (area, focus, blocking reason, version note) | 2,000 characters |
| Text (task description, result, project state, checkpoint parts) | 50,000 characters |
| Documents, instructions, working rules, project descriptions | 400,000 characters |
| Comments | 20,000 characters |
| List page size | 25 by default, 100 at most |
