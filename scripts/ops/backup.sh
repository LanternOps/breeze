#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.prod.yml"
ENV_FILE="${BREEZE_ENV_FILE:-${REPO_ROOT}/.env.prod}"
BACKUP_DIR="${1:-${REPO_ROOT}/backups}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[backup] Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

compose() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${BACKUP_DIR}"

db_backup="${BACKUP_DIR}/breeze-db-${timestamp}.sql.gz"
redis_backup="${BACKUP_DIR}/breeze-redis-${timestamp}.rdb"
meta_file="${BACKUP_DIR}/breeze-backup-${timestamp}.txt"

echo "[backup] Ensuring PostgreSQL and Redis are running"
compose up -d postgres redis >/dev/null
compose exec -T postgres pg_isready -U "${POSTGRES_USER:-breeze}" -d "${POSTGRES_DB:-breeze}" >/dev/null

echo "[backup] Creating PostgreSQL dump: ${db_backup}"
compose exec -T postgres sh -lc "pg_dump -U '${POSTGRES_USER:-breeze}' '${POSTGRES_DB:-breeze}'" | gzip -9 > "${db_backup}"

echo "[backup] Creating Redis snapshot: ${redis_backup}"
compose exec -T redis redis-cli --rdb - > "${redis_backup}"

{
  echo "timestamp_utc=${timestamp}"
  echo "git_commit=$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  echo "database_backup=${db_backup}"
  echo "redis_backup=${redis_backup}"
} > "${meta_file}"

echo "[backup] Complete"
echo "[backup] Metadata: ${meta_file}"
