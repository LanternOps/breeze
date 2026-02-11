#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.prod.yml"
ENV_FILE="${BREEZE_ENV_FILE:-${REPO_ROOT}/.env.prod}"
ENABLE_MONITORING="${ENABLE_MONITORING:-true}"

if [[ $# -ge 1 ]]; then
  ENV_FILE="$1"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] Environment file not found: ${ENV_FILE}" >&2
  echo "[deploy] Copy .env.example to .env.prod and set production values first." >&2
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
  ACME_EMAIL
  POSTGRES_PASSWORD
  JWT_SECRET
  AGENT_ENROLLMENT_SECRET
  METRICS_SCRAPE_TOKEN
  PUBLIC_API_URL
  GRAFANA_ADMIN_PASSWORD
)

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[deploy] Missing required env var: ${name}" >&2
    exit 1
  fi
done

compose() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
}

mkdir -p "${REPO_ROOT}/monitoring/secrets"
printf '%s\n' "${METRICS_SCRAPE_TOKEN}" > "${REPO_ROOT}/monitoring/secrets/metrics_scrape_token"
chmod 600 "${REPO_ROOT}/monitoring/secrets/metrics_scrape_token"

compose config >/dev/null

echo "[deploy] Starting stateful services (PostgreSQL, Redis)"
compose up -d postgres redis

echo "[deploy] Waiting for PostgreSQL readiness"
for _ in {1..30}; do
  if compose exec -T postgres pg_isready -U "${POSTGRES_USER:-breeze}" -d "${POSTGRES_DB:-breeze}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! compose exec -T postgres pg_isready -U "${POSTGRES_USER:-breeze}" -d "${POSTGRES_DB:-breeze}" >/dev/null 2>&1; then
  echo "[deploy] PostgreSQL did not become ready in time" >&2
  exit 1
fi

echo "[deploy] Running database migrations"
(
  cd "${REPO_ROOT}"
  export DATABASE_URL="postgresql://${POSTGRES_USER:-breeze}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-breeze}"
  pnpm db:migrate
)

echo "[deploy] Deploying application stack"
if [[ "${ENABLE_MONITORING}" == "true" ]]; then
  compose up -d --build --remove-orphans
else
  compose up -d --build --remove-orphans caddy api web postgres redis
fi

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
