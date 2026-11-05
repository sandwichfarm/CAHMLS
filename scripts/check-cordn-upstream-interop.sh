#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

upstream_url="${CORDN_UPSTREAM_URL:-https://github.com/Cordn-msg/cordn.git}"
upstream_commit="${CORDN_UPSTREAM_COMMIT:-69a40f5003a6dffef183e1e2b8d5d0038de98b1a}"
upstream_dir="$(mktemp -d /tmp/cordn-upstream-interop-XXXXXX)"

cleanup() {
  if command -v gio >/dev/null 2>&1; then
    gio trash "$upstream_dir" >/dev/null 2>&1 || true
    return
  fi

  printf 'Temporary upstream checkout remains at %s\n' "$upstream_dir" >&2
}
trap cleanup EXIT

git clone --quiet --depth=1 --filter=blob:none "$upstream_url" "$upstream_dir"
git -C "$upstream_dir" fetch --quiet --depth=1 origin "$upstream_commit"
git -C "$upstream_dir" checkout --quiet --detach FETCH_HEAD

actual_commit="$(git -C "$upstream_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$upstream_commit" ]]; then
  printf 'Pinned upstream checkout mismatch: expected %s, got %s\n' "$upstream_commit" "$actual_commit" >&2
  exit 1
fi

pnpm --dir "$upstream_dir" install --frozen-lockfile
CORDN_UPSTREAM_CLI_SESSION="$upstream_dir/packages/cli/src/session.ts" \
  pnpm --filter @cahmls/sdk exec vitest run tests/cordn-upstream-interop.test.ts --reporter=dot
