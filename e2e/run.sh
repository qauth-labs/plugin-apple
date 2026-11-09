#!/usr/bin/env bash
# The end-to-end suite: QAuth's server image with this plugin installed the
# way an operator installs it, against a mock Apple, driven over HTTP by
# e2e/apple.e2e.test.ts.
#
# Needs docker (with compose), git, openssl, node and pnpm. Run it from
# anywhere:
#
#   pnpm run e2e
#
# QAUTH_IMAGE and QAUTH_MIGRATION_IMAGE name the server and migration-runner
# images. Until a released image carries the preset loader
# (qauth-labs/qauth#671), they default to the images qauth-images.sh builds
# from the commit e2e/qauth-commit names, and run.sh runs it first.
#
# It packs the plugin as npm would receive it, makes throwaway secrets, a
# throwaway CA and a test key in e2e/.work/, builds the image (e2e/Dockerfile),
# starts the deployment (e2e/compose.yml), runs the suite and takes everything
# down. On a failure it prints the server's and the mock's logs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
work="$here/.work"
compose=(docker compose --file "$here/compose.yml")

commit="$(tr -d '[:space:]' < "$here/qauth-commit")"
if [ -z "${QAUTH_IMAGE:-}" ] && [ -z "${QAUTH_MIGRATION_IMAGE:-}" ]; then
  bash "$here/qauth-images.sh"
fi
QAUTH_IMAGE="${QAUTH_IMAGE:-qauth-e2e/auth-server:$commit}"
QAUTH_MIGRATION_IMAGE="${QAUTH_MIGRATION_IMAGE:-qauth-e2e/migration-runner:$commit}"
export QAUTH_IMAGE QAUTH_MIGRATION_IMAGE

rm -rf "$work"
mkdir -p "$work/certs" "$work/ca" "$work/keys" "$work/pack"

# A CA for this run only, and the mock's certificate for every name it is
# reached by: Apple's host name for the server, localhost for the suite.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=plugin-apple e2e CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout "$work/ca/ca.key" -out "$work/certs/ca.crt" 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=appleid.apple.com' \
  -keyout "$work/certs/mock.key" -out "$work/ca/mock.csr" 2> /dev/null
printf '%s\n' 'subjectAltName=DNS:appleid.apple.com,DNS:localhost' \
  'extendedKeyUsage=serverAuth' > "$work/ca/mock.ext"
openssl x509 -req -in "$work/ca/mock.csr" -CA "$work/certs/ca.crt" -CAkey "$work/ca/ca.key" \
  -CAcreateserial -days 1 -extfile "$work/ca/mock.ext" -out "$work/certs/mock.crt" 2> /dev/null
# The mock reads its key through a read-only bind mount.
chmod 644 "$work/certs/mock.key"

# The server's signing key and secrets, fresh for this run.
openssl genpkey -algorithm ed25519 -out "$work/keys/jwt-private.pem" 2> /dev/null
openssl pkey -in "$work/keys/jwt-private.pem" -pubout -out "$work/keys/jwt-public.pem"
JWT_PRIVATE_KEY="$(cat "$work/keys/jwt-private.pem")"
JWT_PUBLIC_KEY="$(cat "$work/keys/jwt-public.pem")"
KEK="$(openssl rand -base64 32)"
SESSION_COOKIE_SECRET="$(openssl rand -base64 48)"
export JWT_PRIVATE_KEY JWT_PUBLIC_KEY KEK SESSION_COOKIE_SECRET

# The developer team at the mock Apple: its Team ID, the Services ID, and the
# key Apple would issue for Sign in with Apple, a P-256 key in PKCS #8 as
# Apple's .p8 file is, under a ten-character Key ID. The mock holds its public
# half; the private half is what an operator imports into QAuth's signer
# (qauth-labs/qauth#1073). The plugin never sees it.
MOCK_APPLE_TEAM_ID="$(openssl rand -hex 5 | tr 'a-f' 'A-F')"
MOCK_APPLE_KEY_ID="$(openssl rand -hex 5 | tr 'a-f' 'A-F')"
MOCK_APPLE_SERVICES_ID="dev.qauth.plugin-apple.e2e"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -out "$work/keys/AuthKey_$MOCK_APPLE_KEY_ID.p8" 2> /dev/null
MOCK_APPLE_PUBLIC_KEY="$(openssl pkey -in "$work/keys/AuthKey_$MOCK_APPLE_KEY_ID.p8" -pubout)"
export MOCK_APPLE_TEAM_ID MOCK_APPLE_KEY_ID MOCK_APPLE_SERVICES_ID MOCK_APPLE_PUBLIC_KEY

# The allowlist is read through a bind mount; others must not be able to write it.
chmod 644 "$here/egress-allowlist.json"

# The plugin as npm would receive it, and the plugin SDK it depends on: the
# vendored tarball, until the SDK is on npm (vendor/README.md).
(cd "$root" && pnpm run build > /dev/null && pnpm pack --pack-destination "$work/pack" > /dev/null)
cp "$work"/pack/*.tgz "$work/plugin.tgz"
cp "$root/vendor/qauth-labs-plugin-sdk-0.2.2.tgz" "$work/plugin-sdk.tgz"

finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- the end-to-end suite failed; the deployment's logs follow ---" >&2
    "${compose[@]}" --profile plugin-api-off logs --no-color auth-server auth-server-plugin-api-off \
      mock-apple migrate >&2 || true
  fi
  "${compose[@]}" --profile plugin-api-off down --volumes --remove-orphans > /dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

wait_ready() {
  local url="$1" service="$2"
  for _ in $(seq 1 120); do
    if curl --silent --fail "$url" 2> /dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    # A server that stopped at boot will not become ready: stop waiting.
    if [ -n "$("${compose[@]}" --profile plugin-api-off ps --quiet --status exited "$service")" ]; then
      echo "$service stopped during its boot" >&2
      return 1
    fi
    sleep 1
  done
  echo "$url did not become ready" >&2
  return 1
}

"${compose[@]}" build auth-server
"${compose[@]}" up --detach auth-server
wait_ready http://localhost:3000/ready auth-server
# The second server boots on the database the first one seeded.
"${compose[@]}" --profile plugin-api-off up --detach --no-build auth-server-plugin-api-off
wait_ready http://localhost:3010/ready auth-server-plugin-api-off

cd "$root"
E2E_COMPOSE_FILE="$here/compose.yml" \
E2E_WORK="$work" \
NODE_EXTRA_CA_CERTS="$work/certs/ca.crt" \
  pnpm exec vitest run --config e2e/vitest.config.ts
