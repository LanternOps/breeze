#!/usr/bin/env bash

set -euo pipefail

parse_utc_milliseconds() {
  local value="$1"
  node -e '
    const value = process.argv[1];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) process.exit(1);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) process.exit(1);
    const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
    if (new Date(parsed).toISOString() !== canonical) process.exit(1);
    process.stdout.write(String(parsed));
  ' "${value}"
}

# Pure evidence validator shared with remote-access-cutover.test.sh. Boolean
# proofs are ordered: issuer probes, upgrade probes, HTTP ticket+cookie probes,
# zero old processes/sockets, and uniform new-pool digests.
validate_remote_access_cutover_state() {
  local observed_admission_mode="$1"
  local now_ms="$2"
  local writer_drained_at="$3"
  local viewer_drained_at="$4"
  local issuer_probes_closed="$5"
  local upgrade_probes_closed="$6"
  local http_probes_closed="$7"
  local old_pool_zero="$8"
  local pool_uniform="$9"
  local auth_mode="${10}"
  local writer_ms viewer_ms ws_deadline_ms http_deadline_ms viewer_deadline_ms

  [[ "${observed_admission_mode}" == "closed" ]] || return 1
  [[ "${issuer_probes_closed}" == "1" ]] || return 1
  [[ "${upgrade_probes_closed}" == "1" ]] || return 1
  [[ "${http_probes_closed}" == "1" ]] || return 1
  [[ "${old_pool_zero}" == "1" ]] || return 1
  [[ "${pool_uniform}" == "1" ]] || return 1
  [[ "${auth_mode}" == "post_upgrade" || "${auth_mode}" == "pre_upgrade" ]] || return 1
  [[ "${now_ms}" =~ ^[0-9]+$ ]] || return 1

  writer_ms="$(parse_utc_milliseconds "${writer_drained_at}")" || return 1
  viewer_ms="$(parse_utc_milliseconds "${viewer_drained_at}")" || return 1
  ws_deadline_ms=$((writer_ms + 60 * 1000))
  http_deadline_ms=$((writer_ms + 300 * 1000))
  viewer_deadline_ms=$((viewer_ms + (7200 + 60) * 1000))

  echo "[deploy] Remote WS V0 drain deadline (60s): ${ws_deadline_ms}"
  echo "[deploy] Remote HTTP/cookie V0 drain deadline (300s): ${http_deadline_ms}"
  echo "[deploy] Legacy viewer + V1 ticket drain deadline (7200s+60s): ${viewer_deadline_ms}"

  # The external barrier cannot reopen at the earlier WS deadline. Both the
  # HTTP/cookie maximum and pool proof must complete first. The longer
  # legacy-viewer compatibility deadline gates only pre_upgrade mode.
  (( now_ms >= http_deadline_ms )) || return 1
  if [[ "${auth_mode}" == "pre_upgrade" ]]; then
    (( now_ms >= viewer_deadline_ms )) || return 1
  fi
}

if [[ "${BREEZE_DEPLOY_LIBRARY_ONLY:-false}" == "true" ]]; then
  return 0 2>/dev/null || exit 0
fi

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
require_command node

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
  REMOTE_ACCESS_ADMISSION_MODE
  REMOTE_WS_AUTH_MODE
  REMOTE_WS_REDIS_TOPOLOGY
  REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT
  REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT
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

case "${REMOTE_ACCESS_ADMISSION_MODE}" in
  open|closed) ;;
  *) echo "[deploy] REMOTE_ACCESS_ADMISSION_MODE must be open or closed" >&2; exit 1 ;;
esac
case "${REMOTE_WS_AUTH_MODE}" in
  post_upgrade|pre_upgrade) ;;
  *) echo "[deploy] REMOTE_WS_AUTH_MODE must be post_upgrade or pre_upgrade" >&2; exit 1 ;;
esac
case "${REMOTE_WS_REDIS_TOPOLOGY}" in
  standalone-single-primary) ;;
  *) echo "[deploy] REMOTE_WS_REDIS_TOPOLOGY must be standalone-single-primary" >&2; exit 1 ;;
esac

parse_utc_milliseconds "${REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT}" >/dev/null || {
  echo "[deploy] REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT must be a UTC timestamp" >&2
  exit 1
}
parse_utc_milliseconds "${REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT}" >/dev/null || {
  echo "[deploy] REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT must be a UTC timestamp" >&2
  exit 1
}

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

redis_info() {
  compose exec -T redis sh -ec '
    password="$(cat /run/secrets/redis_password)"
    redis-cli --no-auth-warning -a "$password" INFO
    redis-cli --no-auth-warning -a "$password" CONFIG GET maxmemory-policy
  '
}

assert_supported_redis_topology() {
  local info
  info="$(redis_info)" || {
    echo "[deploy] Redis topology preflight unavailable" >&2
    return 1
  }
  grep -Eq '^role:master\r?$' <<<"${info}" || {
    echo "[deploy] Redis must be a standalone primary" >&2
    return 1
  }
  grep -Eq '^cluster_enabled:0\r?$' <<<"${info}" || {
    echo "[deploy] Redis cluster mode is unsupported" >&2
    return 1
  }
  grep -Eq '^aof_enabled:1\r?$' <<<"${info}" || {
    echo "[deploy] Redis AOF persistence must be enabled" >&2
    return 1
  }
  grep -A1 -x 'maxmemory-policy' <<<"${info}" | grep -qx 'noeviction' || {
    echo "[deploy] Redis maxmemory-policy must be noeviction" >&2
    return 1
  }
}

expect_barrier_status() {
  local path="$1"
  shift
  local status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@" "https://${BREEZE_DOMAIN}${path}")"
  [[ "${status}" == "503" ]]
}

probe_remote_access_issuers_closed() {
  local issuer_path
  for issuer_path in \
    "/api/v1/remote/sessions/00000000-0000-4000-8000-000000000000/ws-ticket" \
    "/api/v1/desktop-ws/00000000-0000-4000-8000-000000000000/viewer/ws-ticket" \
    "/api/v1/tunnels/00000000-0000-4000-8000-000000000000/ws-ticket" \
    "/api/v1/tunnels/00000000-0000-4000-8000-000000000000/http-ticket" \
    "/api/v1/vnc-exchange/00000000-0000-4000-8000-000000000000" \
    "/api/v1/vnc-viewer/downgrade-to-vnc"; do
    expect_barrier_status "${issuer_path}" || return 1
  done
}

probe_remote_access_upgrades_closed() {
  local upgrade_path
  for upgrade_path in \
    "/api/v1/remote/sessions/00000000-0000-4000-8000-000000000000/ws" \
    "/api/v1/desktop-ws/00000000-0000-4000-8000-000000000000/ws" \
    "/api/v1/tunnel-ws/00000000-0000-4000-8000-000000000000/ws"; do
    expect_barrier_status "${upgrade_path}" || return 1
  done
}

probe_remote_access_http_closed() {
  expect_barrier_status \
    "/api/v1/tunnel-http/00000000-0000-4000-8000-000000000000/?__bzt=legacy-v0-probe" \
    || return 1
  expect_barrier_status \
    "/api/v1/tunnel-http/00000000-0000-4000-8000-000000000000/" \
    --header "Cookie: bz_tunnel_00000000-0000-4000-8000-000000000000=valid-cookie-probe" \
    || return 1
}

probe_remote_access_barrier() {
  probe_remote_access_issuers_closed \
    && probe_remote_access_upgrades_closed \
    && probe_remote_access_http_closed
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

assert_supported_redis_topology

# Always apply and verify the authoritative proxy barrier before stopping the
# legacy API pool. A failure below leaves this recreated Caddy instance closed.
target_remote_access_admission_mode="${REMOTE_ACCESS_ADMISSION_MODE}"
export REMOTE_ACCESS_ADMISSION_MODE=closed
echo "[deploy] Closing and probing remote-access admission"
compose up -d --force-recreate --no-deps caddy
probe_remote_access_barrier || {
  echo "[deploy] Remote-access barrier probe failed; leaving admission closed" >&2
  exit 1
}

echo "[deploy] Stopping legacy API ticket/viewer issuers"
compose stop api
old_pool_zero=0
if [[ -z "$(compose ps --status running -q api)" ]]; then
  # A stopped process cannot retain a WebSocket or tunnel-HTTP socket. Check the
  # actual container runtime state as well as Compose's view before declaring
  # both old processes and their sockets absent.
  old_pool_zero=1
fi
if [[ "${old_pool_zero}" != "1" ]]; then
  echo "[deploy] Legacy API process remains running; leaving admission closed" >&2
  exit 1
fi
http_probes_closed=0
if probe_remote_access_http_closed; then
  http_probes_closed=1
fi

echo "[deploy] Running database migrations"
(
  cd "${REPO_ROOT}"
  export DATABASE_URL
  pnpm db:migrate
)

echo "[deploy] Deploying application stack"
compose up -d --remove-orphans

expected_api_ref="ghcr.io/lanternops/breeze/api@${BREEZE_API_IMAGE_DIGEST}"
pool_uniform=0
api_container_count=0
api_digest_mismatch=0
while IFS= read -r api_container_id; do
  [[ -n "${api_container_id}" ]] || continue
  api_container_count=$((api_container_count + 1))
  running_api_ref="$(docker inspect "${api_container_id}" --format '{{.Config.Image}}')"
  if [[ "${running_api_ref}" != "${expected_api_ref}" ]]; then
    api_digest_mismatch=1
  fi
done < <(compose ps --status running -q api)
if (( api_container_count > 0 && api_digest_mismatch == 0 )); then
  pool_uniform=1
fi

issuer_probes_closed=0
upgrade_probes_closed=0
if probe_remote_access_issuers_closed; then
  issuer_probes_closed=1
fi
if probe_remote_access_upgrades_closed; then
  upgrade_probes_closed=1
fi

now_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
if ! validate_remote_access_cutover_state \
  closed \
  "${now_ms}" \
  "${REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT}" \
  "${REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT}" \
  "${issuer_probes_closed}" \
  "${upgrade_probes_closed}" \
  "${http_probes_closed}" \
  "${old_pool_zero}" \
  "${pool_uniform}" \
  "${REMOTE_WS_AUTH_MODE}"; then
  echo "[deploy] Remote-access cutover evidence incomplete; leaving admission closed" >&2
  exit 1
fi

if [[ "${target_remote_access_admission_mode}" == "open" ]]; then
  echo "[deploy] Reopening remote-access admission after verified drains"
  export REMOTE_ACCESS_ADMISSION_MODE=open
  compose up -d --force-recreate --no-deps caddy
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
