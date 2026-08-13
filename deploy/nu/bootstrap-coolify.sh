#!/usr/bin/env bash
# =============================================================================
# bootstrap-coolify.sh — bring up NU RMM (Breeze) on a FRESH Coolify server.
#
# Read BOOTSTRAP.md first — it narrates every step and the landmines.
# This script is meant to run ON the Coolify server (titan01-style layout:
# Coolify API on localhost:8000, coolify-db container, docker volumes on
# /var/lib/docker/volumes).
#
# Required env:
#   COOLIFY_TOKEN     Coolify API token
#   PROJECT_UUID      Coolify project to create the service in
#   SERVER_UUID       Coolify server uuid (the host itself)
#   ENV_FILE          path to a FILLED-IN copy of env.nu.example (real values)
#
# Optional env:
#   COOLIFY_HOST      default http://localhost:8000
#   ENVIRONMENT_NAME  default production
#   DB_DUMP           path to a gzipped pg_dump to restore (skip if unset)
#   PG_CONTAINER      Postgres resource container name (required if DB_DUMP set)
#   PG_USER / PG_DB   default breeze / breeze
#   RELEASE_STAGE_DIR staged agent/viewer binaries to rsync into the data
#                     volume (skip if unset). Produce with:
#                     agent/installer/release/stage-release.sh (builds+signs)
#   CADDYFILE         default: Caddyfile next to this script
#   SKIP_SMOKE        set to 1 to skip the final smoke test
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COOLIFY_HOST="${COOLIFY_HOST:-http://localhost:8000}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-production}"
CADDYFILE="${CADDYFILE:-${SCRIPT_DIR}/Caddyfile}"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.nu.yml"
PG_USER="${PG_USER:-breeze}"
PG_DB="${PG_DB:-breeze}"

: "${COOLIFY_TOKEN:?COOLIFY_TOKEN must be set}"
: "${PROJECT_UUID:?PROJECT_UUID must be set}"
: "${SERVER_UUID:?SERVER_UUID must be set}"
: "${ENV_FILE:?ENV_FILE must be set (filled-in copy of env.nu.example)}"

for f in "${COMPOSE_FILE}" "${CADDYFILE}" "${ENV_FILE}"; do
  [[ -f "${f}" ]] || { echo "ERROR: missing file: ${f}" >&2; exit 1; }
done
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }

api() {
  # api METHOD PATH [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "${method}" "${COOLIFY_HOST}/api/v1${path}"
    -H "Authorization: Bearer ${COOLIFY_TOKEN}"
    -H 'Accept: application/json')
  if [[ -n "${body}" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "${body}")
  fi
  curl "${args[@]}"
}

# ---------------------------------------------------------------------------
# Step 1: create the service from the tracked compose
# (Coolify's create endpoint expects docker_compose_raw base64-encoded.)
# ---------------------------------------------------------------------------
echo "==> [1/7] Creating Coolify service from ${COMPOSE_FILE}"
compose_b64="$(base64 <"${COMPOSE_FILE}" | tr -d '\n')"
create_body="$(jq -n \
  --arg project "${PROJECT_UUID}" \
  --arg server "${SERVER_UUID}" \
  --arg env_name "${ENVIRONMENT_NAME}" \
  --arg compose "${compose_b64}" \
  '{name: "nu-rmm-breeze", project_uuid: $project, server_uuid: $server,
    environment_name: $env_name, docker_compose_raw: $compose,
    instant_deploy: false}')"
create_resp="$(api POST "/services" "${create_body}")"
SERVICE_UUID="$(printf '%s' "${create_resp}" | jq -r '.uuid // empty')"
if [[ -z "${SERVICE_UUID}" ]]; then
  echo "ERROR: service creation failed:" >&2
  printf '%s\n' "${create_resp}" >&2
  exit 1
fi
echo "    service uuid: ${SERVICE_UUID}"

# ---------------------------------------------------------------------------
# Step 2: push environment variables via the API.
# NEVER write envs with psql: Coolify stores env values with Laravel
# encrypted casts. The REST API/UI encrypt on write; a raw DB insert stores
# plaintext that Coolify then fails to decrypt (corrupt env, broken deploys).
# ---------------------------------------------------------------------------
echo "==> [2/7] Loading env vars from ${ENV_FILE} (via API — never psql)"
env_count=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  # skip blanks and comments
  [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  # strip trailing inline comments only if you keep them out of real values;
  # the filled-in env file should contain raw KEY=VALUE lines.
  if [[ "${value}" == *CHANGE_ME* ]]; then
    echo "ERROR: ${key} is still CHANGE_ME in ${ENV_FILE} — fill in real values first." >&2
    exit 1
  fi
  env_body="$(jq -n --arg k "${key}" --arg v "${value}" \
    '{key: $k, value: $v, is_preview: false}')"
  resp="$(api POST "/services/${SERVICE_UUID}/envs" "${env_body}")"
  if printf '%s' "${resp}" | jq -e '.message? // empty | test("already"; "i")' >/dev/null 2>&1; then
    # exists — update instead
    api PATCH "/services/${SERVICE_UUID}/envs" "${env_body}" >/dev/null
  fi
  env_count=$((env_count + 1))
done <"${ENV_FILE}"
echo "    pushed ${env_count} env vars"

# ---------------------------------------------------------------------------
# Step 3: restore the database dump (optional).
# Postgres is a SEPARATE Coolify resource — create it in the UI/API first and
# point DATABASE_URL at it. The API auto-migrates on boot, so a fresh empty
# DB also works (you lose historical data, obviously).
# ---------------------------------------------------------------------------
if [[ -n "${DB_DUMP:-}" ]]; then
  : "${PG_CONTAINER:?PG_CONTAINER must be set when DB_DUMP is provided}"
  echo "==> [3/7] Restoring DB dump ${DB_DUMP} into ${PG_CONTAINER} (${PG_DB})"
  gunzip -c "${DB_DUMP}" | docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}"
else
  echo "==> [3/7] No DB_DUMP set — skipping restore (API will auto-migrate a fresh schema)"
fi

# ---------------------------------------------------------------------------
# Step 4: stage agent/viewer binaries into the breeze-api data volume.
# BINARY_SOURCE=local means the API serves downloads from the volume; if this
# is empty every agent/viewer download 404s.
# Volume path pattern: /var/lib/docker/volumes/<SERVICE_UUID>_breeze-api-data/_data/binaries
# Build+sign the staged tree with: agent/installer/release/stage-release.sh
# ---------------------------------------------------------------------------
BIN_VOLUME_DIR="/var/lib/docker/volumes/${SERVICE_UUID}_breeze-api-data/_data/binaries"
if [[ -n "${RELEASE_STAGE_DIR:-}" ]]; then
  echo "==> [4/7] Staging binaries from ${RELEASE_STAGE_DIR} -> ${BIN_VOLUME_DIR}"
  mkdir -p "${BIN_VOLUME_DIR}"
  rsync -av --delete "${RELEASE_STAGE_DIR}/" "${BIN_VOLUME_DIR}/"
else
  echo "==> [4/7] No RELEASE_STAGE_DIR set — skipping binary staging."
  echo "    Agent/viewer downloads will fail until you rsync a staged release to:"
  echo "    ${BIN_VOLUME_DIR}"
fi

# ---------------------------------------------------------------------------
# Step 5: write the Caddyfile into Coolify's LocalFileVolume row.
# LANDMINE: if local_file_volumes.content is NULL, Deploy writes an EMPTY
# file at ./coolify/Caddyfile and the whole site goes down (Caddy serves
# nothing). local_file_volumes.content is NOT encrypted, so psql is safe here.
# ---------------------------------------------------------------------------
echo "==> [5/7] Writing Caddyfile content into Coolify local_file_volumes"
{
  printf "UPDATE local_file_volumes SET content = \$caddy\$"
  cat "${CADDYFILE}"
  printf "\$caddy\$ WHERE fs_path LIKE '%%coolify/Caddyfile' AND resource_id IN "
  printf "(SELECT id FROM service_applications WHERE service_id = (SELECT id FROM services WHERE uuid = '%s'));\n" "${SERVICE_UUID}"
  printf "SELECT count(*) AS caddyfile_rows_with_content FROM local_file_volumes WHERE fs_path LIKE '%%coolify/Caddyfile' AND content IS NOT NULL;\n"
} | docker exec -i coolify-db psql -U coolify -d coolify
echo "    NOTE: the LocalFileVolume row is created by Coolify when it first"
echo "    parses the compose. If 0 rows updated, open the service once in the"
echo "    Coolify UI (or trigger one deploy), re-run this step, then redeploy."

# ---------------------------------------------------------------------------
# Step 6: deploy
# ---------------------------------------------------------------------------
echo "==> [6/7] Triggering deploy"
deploy_resp="$(api GET "/deploy?uuid=${SERVICE_UUID}")"
printf '%s\n' "${deploy_resp}" | jq . 2>/dev/null || printf '%s\n' "${deploy_resp}"

# ---------------------------------------------------------------------------
# Step 7: smoke test
# ---------------------------------------------------------------------------
if [[ "${SKIP_SMOKE:-0}" == "1" ]]; then
  echo "==> [7/7] SKIP_SMOKE=1 — done. Run smoke.sh manually once the deploy settles."
else
  echo "==> [7/7] Waiting 120s for the stack to come up, then running smoke.sh"
  sleep 120
  SMOKE_EMAIL="${SMOKE_EMAIL:-}" SMOKE_PASSWORD="${SMOKE_PASSWORD:-}" "${SCRIPT_DIR}/smoke.sh"
fi

echo "==> Bootstrap complete. Service uuid: ${SERVICE_UUID}"
