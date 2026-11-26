#!/usr/bin/env bash
# Upgrade test on real images: the previous release fills a data volume, then the new image starts on it.
# Checks that the data and the sign-ins survive, that a schema change is applied once with exactly one
# verified pre-migration backup, and that a second start migrates nothing.
#   scripts/container-upgrade.sh <previous-image> <new-image>
# Needs Docker and the repository's npm dependencies (it runs scripts/smoke.ts on the host).
set -euo pipefail

OLD="${1:?usage: container-upgrade.sh <previous-image> <new-image>}"
NEW="${2:?usage: container-upgrade.sh <previous-image> <new-image>}"
PORT="${SMOKE_PORT:-18081}"
NAME="workspace-upgrade-$$"
VOLUME="workspace-upgrade-data-$$"
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

fail() { echo "upgrade test: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; exit 1; }

run_service() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e PUBLIC_URL="$BASE" -e SECRET_KEY="$SECRET" -e LOG_LEVEL=info \
    -p "127.0.0.1:${PORT}:8080" -v "$VOLUME:/data" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    "$1" >/dev/null
}

wait_healthy() {
  local status=starting
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then break; fi
    sleep 2
  done
  fail "container did not become healthy (status: ${status})"
}

cli() {
  docker run --rm -e PUBLIC_URL="$BASE" -e SECRET_KEY="$SECRET" -v "$VOLUME:/data" "$NEW" cli "$@"
}

# Counts JSON log lines with the given message.
count_msg() { grep -c "\"msg\":\"$2\"" <<<"$1" || true; }

version() { curl -fsS "$BASE/healthz" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).version))'; }

echo "== previous: $OLD"
echo "== new:      $NEW"

echo "== previous release: first start and data"
run_service "$OLD"
wait_healthy
OLD_VERSION="$(version)"
CODE="$(docker logs "$NAME" 2>&1 | sed -n 's/^ *\([A-Z0-9]\{4\}\(-[A-Z0-9]\{4\}\)\{2,\}\) *$/\1/p' | tail -n1)"
[ -n "$CODE" ] || fail "no setup code in the log of the previous release"
node scripts/smoke.ts "$BASE" "$CODE" first
docker stop -t 20 "$NAME" >/dev/null

echo "== upgrade: new image on the same data"
run_service "$NEW"
wait_healthy
NEW_VERSION="$(version)"
echo "  ok  ${OLD_VERSION} -> ${NEW_VERSION}"
LOGS="$(docker logs "$NAME" 2>&1)"
APP="$(count_msg "$LOGS" 'migration applied')"
AUTH="$(count_msg "$LOGS" 'auth schema migrated')"
BACKUP_LINES="$(count_msg "$LOGS" 'backup before migration')"
node scripts/smoke.ts "$BASE" "" again
docker stop -t 20 "$NAME" >/dev/null

PRE="$(cli backups | awk '/-pre-migration\.sqlite/ {print $1}')"
PRE_COUNT="$(grep -c . <<<"$PRE" || true)"
if [ "$APP" -gt 0 ] || [ "$AUTH" -gt 0 ]; then
  echo "  ok  schema changed: ${APP} app migration(s), auth schema migrated ${AUTH} time(s)"
  [ "$BACKUP_LINES" -eq 1 ] || fail "expected one 'backup before migration' line, got ${BACKUP_LINES}"
  [ "$PRE_COUNT" -eq 1 ] || fail "expected one pre-migration backup, got ${PRE_COUNT}"
  cli verify "/data/backups/${PRE}"
  echo "  ok  one pre-migration backup, verified: ${PRE}"
else
  echo "  ok  no schema change between the two images"
  [ "$BACKUP_LINES" -eq 0 ] || fail "a backup before migration was made without a migration"
  [ "$PRE_COUNT" -eq 0 ] || fail "unexpected pre-migration backup: ${PRE}"
fi

echo "== second start of the new image migrates nothing"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker start "$NAME" >/dev/null
wait_healthy
LOGS="$(docker logs --since "$SINCE" "$NAME" 2>&1)"
for msg in 'migration applied' 'auth schema migrated' 'backup before migration'; do
  [ "$(count_msg "$LOGS" "$msg")" -eq 0 ] || fail "'${msg}' logged again on the second start"
done
echo "  ok  nothing migrated or backed up again"
docker stop -t 20 "$NAME" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = "0" || fail "non-zero exit code on SIGTERM"
echo "container upgrade test passed"
