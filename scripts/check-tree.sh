#!/usr/bin/env bash
# Fails if the tracked tree contains things that must never be in this public repository:
# private keys, real-looking tokens, database files or a filled-in .env.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
files="$(git ls-files)"
if grep -E '(^|/)\.env$|\.sqlite(-wal|-shm)?$|\.pem$|\.key$' <<<"$files"; then
  echo "tracked file that must not be committed (above)"; fail=1
fi
patterns='-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}'
if git grep -nE -e "$patterns" -- . ':!scripts/check-tree.sh' ':!package-lock.json'; then
  echo "secret-looking value in the tree (above)"; fail=1
fi
# The owner interface must never insert markup from strings.
if git grep -nE -e 'innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write' -- ui/; then
  echo "forbidden HTML insertion in ui/ (above)"; fail=1
fi
exit $fail
