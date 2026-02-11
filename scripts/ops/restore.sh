#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.prod.yml"
ENV_FILE="${BREEZE_ENV_FILE:-${REPO_ROOT}/.env.prod}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <db-backup.sql.gz> [redis-backup.rdb]" >&2
  exit 1
fi

DB_BACKUP="$1"
REDIS_BACKUP="${2:-}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[restore] Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${DB_BACKUP}" ]]; then
  echo "[restore] Database backup file not found: ${DB_BACKUP}" >&2
  exit 1
fi

if [[ -n "${REDIS_BACKUP}" && ! -f "${REDIS_BACKUP}" ]]; then
  echo "[restore] Redis backup file not found: ${REDIS_BACKUP}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

compose() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
}

echo "[restore] This will overwrite PostgreSQL database '${POSTGRES_DB:-breeze}'."
read -r -p "Type RESTORE to continue: " confirm
if [[ "${confirm}" != "RESTORE" ]]; then
  echo "[restore] Aborted"
  exit 1
fi

echo "[restore] Stopping API/Web edge services"
compose stop caddy web api >/dev/null || true

echo "[restore] Ensuring PostgreSQL is running"
compose up -d postgres >/dev/null
compose exec -T postgres pg_isready -U "${POSTGRES_USER:-breeze}" -d postgres >/dev/null

echo "[restore] Recreating database ${POSTGRES_DB:-breeze}"
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-breeze}" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB:-breeze}' AND pid <> pg_backend_pid();"
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-breeze}" -d postgres -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB:-breeze}\";"
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-breeze}" -d postgres -c "CREATE DATABASE \"${POSTGRES_DB:-breeze}\";"

echo "[restore] Restoring PostgreSQL from ${DB_BACKUP}"
gunzip -c "${DB_BACKUP}" | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-breeze}" -d "${POSTGRES_DB:-breeze}"

if [[ -n "${REDIS_BACKUP}" ]]; then
  echo "[restore] Restoring Redis from ${REDIS_BACKUP}"
  compose up -d redis >/dev/null
  compose cp "${REDIS_BACKUP}" redis:/data/dump.rdb
  compose restart redis >/dev/null
fi

echo "[restore] Starting application services"
compose up -d caddy web api >/dev/null

echo "[restore] Complete"
