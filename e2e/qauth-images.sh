#!/usr/bin/env bash
# The QAuth server and migration-runner images the end-to-end suite runs,
# built from the one QAuth commit e2e/qauth-commit names.
#
# TEMPORARY. No released QAuth image carries the upstream OpenID Connect
# preset loader this plugin needs (qauth-labs/qauth#671) yet. Until one does,
# this builds both images from that commit, as QAuth's own Dockerfiles build
# them; then the suite moves to the released images, pinned by digest, and
# this script goes.
#
#   bash e2e/qauth-images.sh
#
# It does nothing when both images are already present:
#
#   qauth-e2e/auth-server:<commit>
#   qauth-e2e/migration-runner:<commit>
#
# Otherwise it fetches that one commit of https://github.com/qauth-labs/qauth
# into e2e/.work-qauth/ and builds apps/auth-server/Dockerfile, then
# apps/migration-runner/Dockerfile, with the QAuth checkout as the context.
# The two share their first stage, so the second reuses the install layer.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
commit="$(tr -d '[:space:]' < "$here/qauth-commit")"
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "e2e/qauth-commit must hold one full commit id, not '$commit'" >&2
  exit 1
fi

server="qauth-e2e/auth-server:$commit"
runner="qauth-e2e/migration-runner:$commit"
if docker image inspect "$server" > /dev/null 2>&1 \
  && docker image inspect "$runner" > /dev/null 2>&1; then
  echo "QAuth images of $commit are present: $server, $runner"
  exit 0
fi

checkout="$here/.work-qauth"
rm -rf "$checkout"
mkdir -p "$checkout"
git -C "$checkout" init --quiet
git -C "$checkout" remote add origin https://github.com/qauth-labs/qauth.git
git -C "$checkout" fetch --quiet --depth 1 origin "$commit"
git -C "$checkout" checkout --quiet FETCH_HEAD
if [ "$(git -C "$checkout" rev-parse HEAD)" != "$commit" ]; then
  echo "the fetched commit is not $commit" >&2
  exit 1
fi

echo "Building $server"
docker build --file "$checkout/apps/auth-server/Dockerfile" --tag "$server" "$checkout"
echo "Building $runner"
docker build --file "$checkout/apps/migration-runner/Dockerfile" --tag "$runner" "$checkout"
