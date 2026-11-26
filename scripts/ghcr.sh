#!/usr/bin/env bash
# Minimal registry calls for the release workflow, over the OCI distribution API (ghcr.io).
#   scripts/ghcr.sh tags <owner/name>                       every tag of the image, one per line (none if it does not exist yet)
#   scripts/ghcr.sh put-index <owner/name> <index.json>     uploads an image index by digest, without a tag; prints the digest
# Needs GH_TOKEN (packages: read for tags, packages: write for put-index) and GITHUB_ACTOR.
# Any answer other than success or "this image does not exist" is an error, so a registry failure never
# reads as "not published yet".
set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io}"
cmd="${1:?usage: ghcr.sh tags|put-index <owner/name> [file]}"
repo="${2:?usage: ghcr.sh tags|put-index <owner/name> [file]}"
repo="${repo,,}"

token() {
  curl -fsS --retry 3 -u "${GITHUB_ACTOR:?}:${GH_TOKEN:?}" \
    "https://${REGISTRY}/token?service=${REGISTRY}&scope=repository:${repo}:$1" | jq -er .token
}

case "$cmd" in
  tags)
    TOKEN="$(token pull)"
    body="$(mktemp)"; headers="$(mktemp)"
    trap 'rm -f "$body" "$headers"' EXIT
    status="$(curl -sS --retry 3 -o "$body" -D "$headers" -w '%{http_code}' \
      -H "Authorization: Bearer ${TOKEN}" "https://${REGISTRY}/v2/${repo}/tags/list?n=10000")"
    if [ "$status" = 404 ] && jq -e '.errors[]? | select(.code == "NAME_UNKNOWN")' "$body" >/dev/null 2>&1; then
      exit 0 # the image has never been published
    fi
    [ "$status" = 200 ] || { echo "ghcr.sh: listing tags of ${repo} failed with HTTP ${status}: $(head -c 300 "$body")" >&2; exit 1; }
    if grep -qi '^link:' "$headers"; then echo "ghcr.sh: more tags than one page; extend ghcr.sh to follow pages" >&2; exit 1; fi
    jq -r '.tags // [] | .[]' "$body"
    ;;
  put-index)
    file="${3:?usage: ghcr.sh put-index <owner/name> <index.json>}"
    media="$(jq -er .mediaType "$file")"
    case "$media" in
      application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json) ;;
      *) echo "ghcr.sh: ${file} is not an image index (${media})" >&2; exit 1 ;;
    esac
    digest="sha256:$(sha256sum "$file" | cut -d' ' -f1)"
    TOKEN="$(token pull,push)"
    curl -fsS --retry 3 -X PUT -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: ${media}" \
      --data-binary "@${file}" "https://${REGISTRY}/v2/${repo}/manifests/${digest}" >/dev/null
    echo "$digest"
    ;;
  *)
    echo "ghcr.sh: unknown command ${cmd}" >&2; exit 2 ;;
esac
