#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

NODE_IMAGE='node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd'
TMP_DIR="$(mktemp -d)"
PROJECT_NAME="m365-actions-secret-smoke-$RANDOM-$$"
OVERRIDE_FILE="$TMP_DIR/compose.override.yml"
PROBE_BUNDLE="$TMP_DIR/m365-graph-actions-runtime-probe.cjs"
PRIVATE_JWK="$TMP_DIR/api-signing-private.jwk"

cleanup() {
  M365_GRAPH_ACTIONS_RUNTIME_PROBE_FILE="$PROBE_BUNDLE" \
    docker compose --project-name "$PROJECT_NAME" \
      --env-file deploy/compose-config-test.env \
      -f deploy/docker-compose.prod.yml \
      -f "$OVERRIDE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo 'docker is required for the M365 actions secret runtime smoke' >&2; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm is required for the M365 actions secret runtime smoke' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'a running Docker daemon is required for the M365 actions secret runtime smoke' >&2; exit 1; }

pnpm --filter=@breeze/m365-graph-actions-executor exec tsup \
  ../../scripts/security/m365-graph-actions-runtime-probe.ts \
  --format cjs --platform node --target node22 --out-dir "$TMP_DIR" --clean false

umask 077
node - "$PRIVATE_JWK" <<'NODE'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const output = process.argv[2];
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(output, JSON.stringify({
  ...privateKey.export({ format: 'jwk' }),
  kid: 'm365-runtime-smoke',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['sign'],
}));
NODE

# Standalone Compose bind-mounts file-backed secrets and does not implement
# target uid/gid/mode. Provision those properties on the source file itself.
#
# LOCAL-RUN CAVEAT (macOS): Docker Desktop's VirtioFS/gRPC-FUSE layer remaps
# bind-mount ownership to whichever uid/gid the container runs as, so the
# probe's `uid !== 1001 || gid !== 1001` assertion always observes 1001:1001
# here and cannot fail — verified 2026-07-28 by mounting a deliberately
# root-owned file and reading back uid=1001. Only the mode assertion is
# falsifiable on macOS. The ownership half is real ONLY on the Linux CI
# runner, where bind mounts preserve host uid/gid. Do not conclude from a
# green local run that the ownership check works. The read-profile smoke
# has the identical limitation.
docker run --rm --user 0:0 -v "$TMP_DIR:/work" "$NODE_IMAGE" \
  sh -ec 'chown 1001:1001 /work/api-signing-private.jwk && chmod 0400 /work/api-signing-private.jwk'

cat > "$OVERRIDE_FILE" <<EOF
services:
  api:
    image: ${NODE_IMAGE}
    user: "1001:1001"
    entrypoint: ["node", "/runtime-probe.cjs"]
    command: []
    volumes:
      - \${M365_GRAPH_ACTIONS_RUNTIME_PROBE_FILE:?Set runtime probe file}:/runtime-probe.cjs:ro
secrets:
  # The smoke does not exercise Redis. Replace its environment-backed secret
  # with an inert file-backed mount for this isolated one-shot.
  redis_password: !override
    file: /dev/null
networks:
  breeze:
    name: ${PROJECT_NAME}-breeze
EOF

compose=(
  docker compose --project-name "$PROJECT_NAME"
  --env-file deploy/compose-config-test.env
  -f deploy/docker-compose.prod.yml
  -f "$OVERRIDE_FILE"
)

export M365_GRAPH_ACTIONS_RUNTIME_PROBE_FILE="$PROBE_BUNDLE"

# The checked production declaration defaults to /dev/null while onboarding is
# dark. The API's real boot validator must leave the signing file untouched.
unset M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_SOURCE_FILE
"${compose[@]}" run --no-deps --rm api

# Enabling onboarding makes the same Compose secret declaration bind the
# pre-provisioned JWK. The probe runs as the API's numeric uid/gid and imports
# the real runtime loader; it prints only a stable success message.
export M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_SOURCE_FILE="$PRIVATE_JWK"
"${compose[@]}" run --no-deps --rm \
  -e M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED=true \
  -e 'M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS=*' \
  -e M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID=11111111-1111-1111-1111-111111111111 \
  -e M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION=00000000000000000000000000000000 \
  -e M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF=akv://vault.example.invalid/m365-customer-graph-actions/00000000000000000000000000000000 \
  -e M365_GRAPH_ACTIONS_EXECUTOR_URL=https://executor.example.invalid \
  -e M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE=m365-graph-actions-executor \
  -e M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID=m365-runtime-smoke \
  -e PUBLIC_API_URL=https://breeze.example.invalid \
  api
