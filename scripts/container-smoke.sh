#!/usr/bin/env bash
# Smoke test for the container image: first start, setup, OAuth, data written through MCP, restart,
# sign-in again, offline backup and verify with the service stopped, and the "in use" guard.
#   scripts/container-smoke.sh [image]        (default image: workspace-mcp:local)
# Needs Docker and the repository's npm dependencies (it runs scripts/smoke.ts on the host).
set -euo pipefail

IMAGE="${1:-workspace-mcp:local}"
PORT="${SMOKE_PORT:-18080}"
NAME="workspace-smoke-$$"
VOLUME="workspace-smoke-data-$$"
BASE="http://localhost:${PORT}"
SECRET="$(head -c 32 /dev/urandom | base64)"
STATE="$(mktemp)"
export SMOKE_STATE="$STATE"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$STATE"
}
trap cleanup EXIT

run_service() {
  docker run -d --name "$NAME" \
    -e PUBLIC_URL="$BASE" -e SECRET_KEY="$SECRET" -e LOG_LEVEL=info \
    -p "127.0.0.1:${PORT}:8080" -v "$VOLUME:/data" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then break; fi
    sleep 2
  done
  echo "container did not become healthy (status: ${status:-unknown})" >&2
  docker logs "$NAME" >&2 || true
  return 1
}

cli() {
  docker run --rm -e PUBLIC_URL="$BASE" -e SECRET_KEY="$SECRET" -v "$VOLUME:/data" "$IMAGE" cli "$@"
}

echo "== image: $IMAGE ($(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE"))"
test "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = "node" || { echo "image must run as the non-root user" >&2; exit 1; }

echo "== first start"
run_service
wait_healthy
CODE="$(docker logs "$NAME" 2>&1 | sed -n 's/^ *\([A-Z0-9]\{4\}\(-[A-Z0-9]\{4\}\)\{2,\}\) *$/\1/p' | tail -n1)"
[ -n "$CODE" ] || { echo "no setup code in the log" >&2; docker logs "$NAME" >&2; exit 1; }
node scripts/smoke.ts "$BASE" "$CODE" first

echo "== offline commands refuse to run while the service holds the database"
if out="$(cli backup 2>&1)"; then echo "backup ran while the service was up" >&2; exit 1; fi
grep -q "in use" <<<"$out" || { echo "unexpected message: $out" >&2; exit 1; }
echo "  ok  refused: $(head -n1 <<<"$out")"

echo "== stop, offline backup and verify"
docker stop -t 20 "$NAME" >/dev/null
cli backup
NAME_BAK="$(cli backups | awk '/\.sqlite/ {print $1}' | head -n1)"
[ -n "$NAME_BAK" ] || { cli backups; echo "no backup listed" >&2; exit 1; }
cli verify "/data/backups/${NAME_BAK}"

echo "== restart with the same data"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker start "$NAME" >/dev/null
wait_healthy
if docker logs --since "$SINCE" "$NAME" 2>&1 | grep -q "first-time setup"; then echo "setup code printed again after the owner exists" >&2; exit 1; fi
node scripts/smoke.ts "$BASE" "" again

echo "== graceful shutdown"
docker stop -t 20 "$NAME" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = "0" || { echo "non-zero exit code on SIGTERM" >&2; docker logs "$NAME" >&2; exit 1; }
echo "container smoke test passed"
