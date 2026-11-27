# Deployment

Workspace MCP is one container with no other services. It needs:

- Docker with Compose v2, on Linux `amd64` or `arm64` (a Raspberry Pi 4 or newer is enough).
- A stable public `https` hostname that forwards to the container, through a tunnel or a reverse proxy. AI platforms connect from their own servers, so the address must be reachable from the public internet, on the standard port 443.
- Nothing else: no external database, no accounts, no telemetry.

For a step-by-step deployment on a Raspberry Pi with Cloudflare Tunnel, written so another agent with shell access can follow it, see the [Raspberry Pi runbook](runbook-raspberry-pi.md). This page explains the parts.

## 1. Get the source and build the image

The image is built from this repository; it does not depend on any published image or package. To run a released image instead of building, see [Published images](#published-images).

```sh
git clone https://github.com/viktorermolov/workspace-mcp.git
cd workspace-mcp
docker compose build
```

The build has three stages on `node:26-bookworm-slim`: it installs dependencies, builds the web interface, then copies only the runtime files into a final image that runs as the unprivileged `node` user. The final image is about 90 MB of content.

## 2. Configure

```sh
cp .env.example .env
openssl rand -base64 32      # paste the output as SECRET_KEY in .env
```

Set at least `PUBLIC_URL` (your public hostname, for example `https://workspace.example.com`) and `SECRET_KEY`. Keep `TRUST_PROXY=true` when the service is reached only through a tunnel or proxy. Every setting is described in [configuration.md](configuration.md).

Store a copy of `SECRET_KEY` outside the machine. `PUBLIC_URL` is part of every connection and of the owner passkey: changing it later means registering a new passkey and reconnecting every platform.

## 3. Start

```sh
docker compose up -d
docker compose ps                     # workspace: running (healthy) after a few seconds
curl -s http://127.0.0.1:8080/healthz # {"status":"ok","version":"…"}
```

`compose.yaml` runs the container with a read-only root file system, all Linux capabilities dropped, `no-new-privileges`, a health check, log rotation, and the data in the named volume `workspace-data`. The port is published on `127.0.0.1` only: nothing outside the machine can reach the service until you publish it.

On the first start the log shows a one-time setup code:

```sh
docker compose logs workspace | grep -A2 'enter this one-time code'
```

Do not use it yet; first make the service reachable at `PUBLIC_URL` (next step), then follow [first-time setup](first-setup.md). A new code is printed on every restart until the owner passkey exists; each code expires after 30 minutes.

## 4. Publish over https

The service must be served at the root of its hostname, over `https` on port 443. Three common ways:

### Cloudflare Tunnel (no open ports)

`compose.yaml` contains an optional `cloudflared` service.

1. In the Cloudflare dashboard, create a tunnel of the `cloudflared` type and copy its token. The hostname must be in a zone on your Cloudflare account.
2. Add a public hostname to the tunnel, for example `workspace.example.com`, with service type `HTTP` and URL `workspace:8080` (the Compose service name, reachable from the `cloudflared` container).
3. Put the token in `.env` as `CLOUDFLARED_TOKEN=…` and start it:

   ```sh
   docker compose --profile tunnel up -d
   ```

Things that break AI platform connections on Cloudflare:

- **Cloudflare Access** (or any login wall) in front of the hostname. Platforms must reach `/mcp`, `/.well-known/…` and `/api/auth/oauth2/…` directly. If you use Access for other hostnames, leave this one out.
- **Bot protection and WAF challenges** (Bot Fight Mode, Under Attack mode, managed challenges) on the hostname. Platform servers cannot answer a challenge. If a platform fails during discovery or token exchange, check **Security → Events** in Cloudflare and add a skip rule for this hostname.
- **Quick tunnels** (`trycloudflare.com`) change their address on every start, which invalidates the passkey and connections. Use a named tunnel with your own hostname.

### Caddy

```caddyfile
workspace.example.com {
    reverse_proxy 127.0.0.1:8080 {
        # Clients could otherwise set this header themselves.
        header_up -CF-Connecting-IP
    }
}
```

Caddy obtains the certificate itself and puts the client address in `X-Forwarded-For`, which the service reads with `TRUST_PROXY=true`.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name workspace.example.com;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header CF-Connecting-IP "";
        proxy_buffering off;          # MCP responses may stream
        proxy_read_timeout 300s;
    }
}
```

Whatever you use, `TRUST_PROXY=true` is correct only when every request reaches the service through that one proxy.

### Check from outside

```sh
curl -s https://workspace.example.com/healthz
curl -s https://workspace.example.com/.well-known/oauth-protected-resource/mcp
```

The second command must show `"resource":"https://workspace.example.com/mcp"`. If it shows another host or `http://`, `PUBLIC_URL` does not match the address you published.

## 5. First-time setup

Follow [first-setup.md](first-setup.md): open `PUBLIC_URL`, enter the setup code, register the passkey, connect the first platform.

## Operating

| Task | Command |
| --- | --- |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f workspace` (JSON lines; never contain tokens or content) |
| Restart | `docker compose restart workspace` |
| Stop | `docker compose stop` (the service shuts down cleanly on `SIGTERM`) |
| Offline commands | `docker compose stop workspace && docker compose run --rm workspace cli <command>`; run `cli help` for the list |
| New passkey after losing one | `cli recovery-code`, then open `PUBLIC_URL/setup` and enter the code |
| Backups | see [backups.md](backups.md) |

The service restarts automatically after a crash or reboot (`restart: unless-stopped`), as long as Docker starts at boot.

If you change the code you deploy, set `SOURCE_URL` to where your modified source is published, as the AGPL requires ([details](configuration.md#source-code-agpl)).

## Updating and rolling back

Before an update, keep the current image under a second tag so you can switch back without rebuilding:

```sh
docker tag workspace-mcp:local workspace-mcp:previous
git fetch --tags
git checkout <new tag or commit>        # or: git pull, to follow master
docker compose build
docker compose up -d --force-recreate workspace
docker compose logs --tail 30 workspace # look for "listening"; a schema change logs "backup before migration"
curl -s http://127.0.0.1:8080/healthz   # shows the new version
```

Migrations run automatically at start. If the database already holds data, a `pre-migration` backup is made first.

After upgrading to 0.2.0 (or later, the first time role checks are present): open **Platforms**, review each connection's suggested role list and confirm it, tick the roles that may edit any item, then turn on enforcement when you are ready. Role checks stay in warning mode until you do. After enforcement is on, a newly approved connection cannot write until you confirm its role list.

To roll back:

```sh
docker tag workspace-mcp:previous workspace-mcp:local
docker compose up -d --force-recreate workspace
```

If the newer release migrated the database, the older release refuses to start and says so. Then also restore the newest `pre-migration` backup, as described in [Undoing an upgrade](backups.md#undoing-an-upgrade).

## Published images

Each release `vX.Y.Z` publishes one multi-arch image (`linux/amd64` and `linux/arm64`) to the GitHub Container Registry, with a GitHub Release and its notes. You can also build from source as above.

| Tag | Points to |
| --- | --- |
| `X.Y.Z`, `vX.Y.Z` | That release; never moved or rebuilt. |
| `latest` | The highest released version. A patch for an older line does not move it. |

Prefer a version tag over `latest`, so an update happens only when you choose it; read the release notes first ([Versions and compatibility](../README.md#versions-and-compatibility)).

A release is made by merging into `master` a version bump in `package.json` together with its changelog section. Before an image is tagged, the release workflow runs the full CI on that commit, smoke-tests the exact image that is published on each architecture, and upgrades the previous release to it with data in place. Each release's multi-arch image (what a tag points to) is signed with [cosign](https://docs.sigstore.dev/) (keyless, by the release workflow), and each platform image carries an SBOM and build provenance. The signature is checked against the release workflow on `master` and the commit that the release tag `vX.Y.Z` points to, so an image signed for one version does not verify as another. To verify a release before you run it:

```sh
SHA="$(git ls-remote https://github.com/viktorermolov/workspace-mcp refs/tags/vX.Y.Z | cut -f1)"
cosign verify ghcr.io/viktorermolov/workspace-mcp:X.Y.Z \
  --certificate-identity https://github.com/viktorermolov/workspace-mcp/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-sha "${SHA:?no git tag vX.Y.Z}"
docker buildx imagetools inspect ghcr.io/viktorermolov/workspace-mcp:X.Y.Z --format '{{ json .SBOM }}'
```

To run a published image, set `WORKSPACE_IMAGE=ghcr.io/viktorermolov/workspace-mcp:X.Y.Z` in `.env`, then:

```sh
docker compose pull workspace
docker compose up -d --force-recreate workspace
docker compose logs --tail 30 workspace # "listening"; a schema change logs "backup before migration"
curl -s http://127.0.0.1:8080/healthz   # shows the new version
```

To update, change the version in `WORKSPACE_IMAGE` and run the same commands. To roll back, set the previous version again and run them; if the newer release migrated the database, the older one refuses to start, and you restore the newest `pre-migration` backup as described in [Undoing an upgrade](backups.md#undoing-an-upgrade).

## Running without Docker

The service is a plain Node.js program. With Node.js 26 or newer:

```sh
npm ci
npm run build:ui
PUBLIC_URL=https://workspace.example.com SECRET_KEY=… DATA_DIR=/var/lib/workspace-mcp npm start
```

Use a process manager (for example a systemd unit with `Restart=on-failure`) and the same reverse-proxy setup. Offline commands are `npm run cli -- <command>`.
