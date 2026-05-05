#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/deploy/docker-compose.prod.yml"
MONITORING_COMPOSE_FILE="${REPO_ROOT}/docker-compose.monitoring.yml"
ENV_FILE="${BREEZE_ENV_FILE:-${REPO_ROOT}/.env.prod}"
ENABLE_MONITORING="${ENABLE_MONITORING:-true}"

if [[ $# -ge 1 ]]; then
  ENV_FILE="$1"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] Environment file not found: ${ENV_FILE}" >&2
  echo "[deploy] Copy deploy/.env.example to .env.prod and set production values first." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[deploy] Missing required command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command pnpm
require_command curl

docker compose version >/dev/null 2>&1 || {
  echo "[deploy] docker compose plugin is required" >&2
  exit 1
}

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

if [[ -z "${PUBLIC_API_URL:-}" && -n "${BREEZE_DOMAIN:-}" ]]; then
  export PUBLIC_API_URL="https://${BREEZE_DOMAIN}/api/v1"
fi

required_vars=(
  BREEZE_DOMAIN
  DATABASE_URL
  BREEZE_VERSION
  BREEZE_API_IMAGE_DIGEST
  BREEZE_WEB_IMAGE_DIGEST
  BREEZE_BINARIES_IMAGE_DIGEST
  CADDY_IMAGE_REF
  CLOUDFLARED_IMAGE_REF
  REDIS_IMAGE_REF
  COTURN_IMAGE_REF
  BILLING_IMAGE_REF
  REDIS_PASSWORD
  JWT_SECRET
  AGENT_ENROLLMENT_SECRET
  APP_ENCRYPTION_KEY
  MFA_ENCRYPTION_KEY
  ENROLLMENT_KEY_PEPPER
  MFA_RECOVERY_CODE_PEPPER
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS
  PUBLIC_API_URL
)

if [[ "${ENABLE_MONITORING}" == "true" ]]; then
  required_vars+=(METRICS_SCRAPE_TOKEN GRAFANA_ADMIN_PASSWORD)
fi

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[deploy] Missing required env var: ${name}" >&2
    exit 1
  fi
done

require_sha256_digest() {
  local name="$1"
  if [[ ! "${!name}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "[deploy] ${name} must be a sha256 digest, for example sha256:<64 lowercase hex chars>" >&2
    exit 1
  fi
}

require_digest_ref() {
  local name="$1"
  if [[ ! "${!name}" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "[deploy] ${name} must be digest-pinned with @sha256:<64 lowercase hex chars>" >&2
    exit 1
  fi
}

require_sha256_digest BREEZE_API_IMAGE_DIGEST
require_sha256_digest BREEZE_WEB_IMAGE_DIGEST
require_sha256_digest BREEZE_BINARIES_IMAGE_DIGEST
require_digest_ref CADDY_IMAGE_REF
require_digest_ref CLOUDFLARED_IMAGE_REF
require_digest_ref REDIS_IMAGE_REF
require_digest_ref COTURN_IMAGE_REF
require_digest_ref BILLING_IMAGE_REF

COMPOSE_ARGS=(-f "${COMPOSE_FILE}")
if [[ "${ENABLE_MONITORING}" == "true" ]]; then
  COMPOSE_ARGS+=(-f "${MONITORING_COMPOSE_FILE}")
fi

compose() {
  docker compose "${COMPOSE_ARGS[@]}" --env-file "${ENV_FILE}" "$@"
}

redis_ping() {
  compose exec -T redis sh -ec 'password="$(cat /run/secrets/redis_password)"; { printf "AUTH %s\r\n" "$password"; printf "PING\r\n"; } | redis-cli --no-auth-warning | grep -q PONG'
}

compose config >/dev/null

echo "[deploy] Starting Redis"
compose up -d redis

echo "[deploy] Waiting for Redis readiness"
for _ in {1..30}; do
  if redis_ping >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! redis_ping >/dev/null 2>&1; then
  echo "[deploy] Redis did not become ready in time" >&2
  exit 1
fi

echo "[deploy] Running database migrations"
(
  cd "${REPO_ROOT}"
  export DATABASE_URL
  pnpm db:migrate
)

echo "[deploy] Deploying application stack"
compose up -d --remove-orphans

echo "[deploy] Running smoke checks"
for _ in {1..24}; do
  if curl --silent --show-error --fail "https://${BREEZE_DOMAIN}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

if ! curl --silent --show-error --fail "https://${BREEZE_DOMAIN}/health" >/dev/null; then
  echo "[deploy] Health check failed: https://${BREEZE_DOMAIN}/health" >&2
  exit 1
fi

if [[ "${ENABLE_MONITORING}" == "true" ]]; then
  compose exec -T prometheus wget --no-verbose --tries=1 --spider http://localhost:9090/-/healthy >/dev/null
  compose exec -T grafana wget --no-verbose --tries=1 --spider http://localhost:3000/api/health >/dev/null
fi

echo "[deploy] Success"
echo "[deploy] App URL: https://${BREEZE_DOMAIN}"
if [[ "${ENABLE_MONITORING}" == "true" ]]; then
  echo "[deploy] Grafana URL: http://127.0.0.1:${GRAFANA_PORT:-3000}"
fi
