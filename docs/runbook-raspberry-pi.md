# Runbook: deploy on a Raspberry Pi with Cloudflare Tunnel

This runbook is written for an agent (or a person) with shell access to a Raspberry Pi. Follow the steps in order. Each step lists the commands and the result you should see before moving on. If a result differs, stop at that step and use [Troubleshooting](#troubleshooting).

The result: Workspace MCP running in Docker on the Pi, reachable at a stable `https` hostname through a Cloudflare Tunnel, with no ports opened on the router, waiting for the owner to complete [first-time setup](first-setup.md).

## Inputs you need from the owner

| Input | Example | Why |
| --- | --- | --- |
| Public hostname | `workspace.example.com` | Becomes `PUBLIC_URL`. It must be in a domain the owner manages on Cloudflare. It is permanent: changing it later invalidates the passkey and every connection. |
| Cloudflare Tunnel token | a long string starting with `eyJ` | Lets `cloudflared` on the Pi serve the hostname. The owner creates it in the Cloudflare dashboard, see step 6. |

Treat the tunnel token and the generated `SECRET_KEY` as secrets: write them only into `.env` on the Pi, and do not paste them into chats, issues or logs.

## Requirements

- Raspberry Pi 4 or 5 (or any `arm64`/`amd64` Linux machine) with at least 2 GB of RAM and 4 GB of free disk.
- A 64-bit OS: Raspberry Pi OS (64-bit), Debian or Ubuntu.
- Outbound internet access. No inbound ports are needed.

## Step 1. Check the machine

```sh
uname -m
. /etc/os-release && echo "$PRETTY_NAME"
free -h | head -2
df -h ~ | tail -1
```

Expected: `aarch64` (or `x86_64`), a Debian-based OS, at least 2 GB total memory, at least 4 GB available disk. If `uname -m` prints `armv7l`, the OS is 32-bit: stop and ask the owner to install a 64-bit OS.

## Step 2. Install Docker

Check first:

```sh
docker --version && docker compose version
```

If both print a version (Compose `v2.x` or newer), skip to the check at the end of this step. Otherwise install Docker Engine with Docker's official script and let the current user run it:

```sh
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
```

Log out and in again (or run `newgrp docker`) so the group change applies. Then check:

```sh
docker run --rm hello-world
docker compose version
systemctl is-enabled docker
```

Expected: `Hello from Docker!`, a Compose version, and `enabled` (Docker starts at boot, and with it the service).

## Step 3. Get the source

```sh
cd ~
git clone https://github.com/viktorermolov/workspace-mcp.git
cd ~/workspace-mcp
git log -1 --oneline
```

Expected: the clone succeeds and the last line shows a commit. All later commands run in `~/workspace-mcp`.

To deploy a specific release instead of the latest `master`, run `git checkout vX.Y.Z` now.

## Step 4. Configure

Replace `workspace.example.com` with the owner's hostname:

```sh
cd ~/workspace-mcp
umask 077
cp .env.example .env
HOSTNAME_PUBLIC=workspace.example.com
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${HOSTNAME_PUBLIC}|" .env
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -base64 32)|" .env
grep -E '^(PUBLIC_URL|TRUST_PROXY)=' .env
grep -c '^SECRET_KEY=.\{40,\}' .env
ls -l .env
```

Expected: `PUBLIC_URL=https://<hostname>`, `TRUST_PROXY=true`, the count `1` (a key is set), and `.env` readable only by the current user (`-rw-------`).

Tell the owner that `SECRET_KEY` is in `~/workspace-mcp/.env` and that they should keep a copy in their password manager: backups do not contain it.

## Step 5. Build and start the service

Build the image on the Pi from this repository. On a Raspberry Pi 4 this takes several minutes.

```sh
docker compose build workspace
docker image inspect workspace-mcp:local --format '{{.Architecture}}'
```

Expected: the build ends without errors, and the architecture is `arm64` (or `amd64`).

Start it and wait until the health check passes:

```sh
docker compose up -d workspace
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q workspace)")
  [ "$s" = healthy ] && break; sleep 2
done; echo "$s"
curl -s http://127.0.0.1:8080/healthz; echo
```

Expected: `healthy` and `{"status":"ok","version":"…"}`.

## Step 6. Publish with Cloudflare Tunnel

The owner does this part in the Cloudflare dashboard, because it needs their Cloudflare account. Send them these instructions:

1. Open the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels** and choose **Create a tunnel**, type **Cloudflared**, any name (for example `workspace`).
2. On the install screen, copy the token from any of the shown commands (the long string after `--token` or `install`). Do not run those commands; the Pi runs `cloudflared` in Docker.
3. Add a **public hostname**: the hostname from the inputs, service type **HTTP**, URL **`workspace:8080`**.
4. Make sure no Cloudflare Access application covers this hostname, and that bot challenges (Bot Fight Mode, Under Attack mode) are off for it: AI platforms call it from their servers and cannot pass a login or a challenge.
5. Send the token to the agent through a private channel.

On the Pi, add the token and start the tunnel:

```sh
cd ~/workspace-mcp
read -rs CF_TOKEN   # paste the token, then press Enter
printf 'CLOUDFLARED_TOKEN=%s\n' "$CF_TOKEN" >> .env && unset CF_TOKEN
docker compose --profile tunnel up -d
sleep 10
docker compose logs cloudflared | grep -c 'Registered tunnel connection'
```

Expected: a number of at least `1`.

Check from the public side (replace the hostname):

```sh
curl -s https://workspace.example.com/healthz; echo
curl -s https://workspace.example.com/.well-known/oauth-protected-resource/mcp; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://workspace.example.com/mcp
```

Expected: `{"status":"ok",…}`, a JSON document with `"resource":"https://workspace.example.com/mcp"`, and `401` (the MCP endpoint is protected). If the resource shows a different host, `PUBLIC_URL` in `.env` does not match the hostname: fix it and run `docker compose up -d --force-recreate workspace`.

## Step 7. Hand over to the owner

Get the current setup code:

```sh
docker compose logs workspace | grep -A2 'enter this one-time code' | tail -3
```

Expected: a line with `Open https://<hostname>/setup and enter this one-time code:` followed by a code like `ABCD-EFGH-JKLM-NPQR`. A code expires 30 minutes after it was printed. If it has expired, run `docker compose restart workspace` and read the new one.

Send the owner the URL, the code and a link to [first-time setup](first-setup.md). The setup code gives control of the workspace to whoever uses it first, so send it through a private channel and only to the owner.

After the owner says setup is done, confirm that no new code is printed on restart:

```sh
docker compose restart workspace && sleep 5
docker compose logs --since 1m workspace | grep -c 'enter this one-time code'
```

Expected: `0`.

## Step 8. Verify the deployment

```sh
cd ~/workspace-mcp
docker compose ps
docker compose run --rm --no-deps workspace cli version
docker compose exec workspace ls -l /data /data/backups
```

Expected: `workspace` and `cloudflared` are `running`, `workspace` is `(healthy)`; the version matches the checkout; `/data` holds `workspace.sqlite` and a `backups` directory.

Reboot test (optional, with the owner's agreement):

```sh
sudo reboot
# after the Pi is back:
cd ~/workspace-mcp && docker compose ps && curl -s https://workspace.example.com/healthz
```

Expected: both services running again and the public health check answering.

## Updating

```sh
cd ~/workspace-mcp
docker tag workspace-mcp:local workspace-mcp:previous
git fetch --tags origin
git checkout master && git pull --ff-only      # or: git checkout vX.Y.Z
docker compose build workspace
docker compose up -d --force-recreate workspace
docker compose logs --tail 30 workspace
curl -s http://127.0.0.1:8080/healthz; echo
```

Expected: a `listening` line in the log and the new version in the health check. If the release changes the database, the log first shows `backup before migration` with the name of the backup.

## Rolling back

```sh
cd ~/workspace-mcp
docker tag workspace-mcp:previous workspace-mcp:local
docker compose up -d --force-recreate workspace
docker compose logs --tail 20 workspace
```

Expected: the older version starts and answers `/healthz`.

If instead the log says `The database was upgraded by a newer release`, the update migrated the database. Restore the backup made before the migration:

```sh
docker compose stop workspace
docker compose run --rm --no-deps workspace cli backups | grep pre-migration | tail -1
docker compose run --rm --no-deps workspace cli restore <name from the previous line>
docker compose up -d workspace
```

Changes made after the update are saved in a `pre-restore` backup by the restore command.

## Backups off the Pi

Automatic backups run daily into the volume. Copy them off the Pi regularly, for example to a USB disk or another machine:

```sh
cd ~/workspace-mcp
docker compose cp workspace:/data/backups ./backups-copy
```

See [backups.md](backups.md) for restore, export and import.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `docker compose up` exits, log shows `Configuration error: …` | A setting in `.env` is invalid; the message names it. See [configuration.md](configuration.md). |
| `bind: address already in use` | Port 8080 on the Pi is taken. Set `HOST_PORT=8081` in `.env` and start again (the tunnel is unaffected). |
| Log shows `The database is locked by another process` | Another container uses the same volume. `docker ps` and stop the other one. |
| Log shows `The database was upgraded by a newer release` | An older image runs against a newer database. See [Rolling back](#rolling-back). |
| Public URL returns Cloudflare error 1033 | `cloudflared` is not running or the token is wrong: `docker compose logs cloudflared`. |
| Public URL returns 502 | The tunnel's public hostname does not point to `workspace:8080`, or the `workspace` container is not healthy. |
| Setup page says the code is invalid | The code expired or was already used. `docker compose restart workspace` prints a new one. |
| An AI platform cannot connect | In the web interface, open **More → Connections → Diagnostics**: every step of each attempt is recorded. Check Cloudflare **Security → Events** for blocked requests. |
| Build fails with `SELF_SIGNED_CERT_IN_CHAIN` | A TLS-inspecting proxy is in the way. Build with its CA: `docker build --secret id=extra_ca,src=/path/ca.pem -t workspace-mcp:local .` |
