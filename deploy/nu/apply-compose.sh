#!/usr/bin/env bash
# =============================================================================
# apply-compose.sh — push deploy/nu/docker-compose.nu.yml into the Coolify
# Service and trigger a deploy.
#
# Usage (typically on titan01, where the Coolify API listens on localhost):
#   COOLIFY_TOKEN=... [COOLIFY_HOST=http://localhost:8000] \
#     [SERVICE_UUID=zsv4uxqp8xoozq1c069b9oco] ./apply-compose.sh
#
# What it does:
#   1. PATCH /api/v1/services/{uuid} with {"docker_compose_raw": <file>}.
#   2. Verify the stored compose round-trips (GET the service back).
#   3. GET /api/v1/deploy?uuid={uuid} to trigger a deploy.
#
# FALLBACK if the installed Coolify version's REST API does not accept
# docker_compose_raw on PATCH (older versions ignore or reject the field):
# write it straight into the DB with dollar-quoting, then trigger the deploy
# via the API as usual:
#
#   docker exec -i coolify-db psql -U coolify -d coolify <<SQL
#   UPDATE services
#   SET docker_compose_raw = \$compose\$
#   <paste the full contents of docker-compose.nu.yml here>
#   \$compose\$
#   WHERE uuid = 'zsv4uxqp8xoozq1c069b9oco';
#   SQL
#
# (Dollar-quoting avoids any escaping of quotes/backslashes in the YAML.
#  docker_compose_raw is NOT an encrypted column, so a raw DB write is safe
#  here — unlike environment variables, which must NEVER be written via psql.)
#
# LANDMINE: Coolify's compose parser silently DROPS bare-null network keys
# (`coolify:` with no value). The tracked compose uses dict form everywhere;
# keep it that way.
# =============================================================================
set -euo pipefail

COOLIFY_HOST="${COOLIFY_HOST:-http://localhost:8000}"
SERVICE_UUID="${SERVICE_UUID:-zsv4uxqp8xoozq1c069b9oco}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN must be set (Coolify API token)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.nu.yml"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "ERROR: compose file not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }

echo "==> Uploading ${COMPOSE_FILE} to service ${SERVICE_UUID} at ${COOLIFY_HOST}"

payload="$(jq -Rs '{docker_compose_raw: .}' <"${COMPOSE_FILE}")"

http_code="$(curl -sS -o /tmp/apply-compose-resp.json -w '%{http_code}' \
  -X PATCH "${COOLIFY_HOST}/api/v1/services/${SERVICE_UUID}" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data-binary "${payload}")"

if [[ "${http_code}" != 2* ]]; then
  echo "ERROR: PATCH failed (HTTP ${http_code}):" >&2
  cat /tmp/apply-compose-resp.json >&2 || true
  echo "" >&2
  echo "If this Coolify version's API does not accept docker_compose_raw," >&2
  echo "use the psql fallback documented in the header of this script." >&2
  exit 1
fi

echo "==> PATCH accepted (HTTP ${http_code}). Verifying stored compose..."

stored="$(curl -sS \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H 'Accept: application/json' \
  "${COOLIFY_HOST}/api/v1/services/${SERVICE_UUID}" | jq -r '.docker_compose_raw // empty')"

if [[ -z "${stored}" ]]; then
  echo "WARNING: could not read docker_compose_raw back from the API; skipping diff check." >&2
elif ! diff <(printf '%s' "${stored}") "${COMPOSE_FILE}" >/dev/null 2>&1; then
  echo "WARNING: stored compose differs from the tracked file." >&2
  echo "Coolify may have normalized/re-parsed the YAML — inspect with:" >&2
  echo "  diff <(curl -s -H \"Authorization: Bearer \$COOLIFY_TOKEN\" ${COOLIFY_HOST}/api/v1/services/${SERVICE_UUID} | jq -r .docker_compose_raw) ${COMPOSE_FILE}" >&2
  echo "In particular verify the gateway's coolify network kept its dict form" >&2
  echo "(the parser drops bare-null network keys)." >&2
else
  echo "==> Stored compose matches the tracked file byte-for-byte."
fi

echo "==> Triggering deploy..."
deploy_code="$(curl -sS -o /tmp/apply-compose-deploy.json -w '%{http_code}' \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H 'Accept: application/json' \
  "${COOLIFY_HOST}/api/v1/deploy?uuid=${SERVICE_UUID}")"

if [[ "${deploy_code}" != 2* ]]; then
  echo "ERROR: deploy trigger failed (HTTP ${deploy_code}):" >&2
  cat /tmp/apply-compose-deploy.json >&2 || true
  exit 1
fi

jq . /tmp/apply-compose-deploy.json 2>/dev/null || cat /tmp/apply-compose-deploy.json
echo "==> Deploy triggered. Watch it in the Coolify UI, then run smoke.sh."
