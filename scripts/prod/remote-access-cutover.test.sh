#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  echo "[remote-access-cutover.test] $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq -- "${pattern}" "${file}" \
    || fail "${file#${REPO_ROOT}/} is missing: ${pattern}"
}

remote_paths=(
  /api/v1/remote/sessions/*/ws-ticket
  /api/v1/desktop-ws/*/viewer/ws-ticket
  /api/v1/tunnels/*/ws-ticket
  /api/v1/tunnels/*/http-ticket
  /api/v1/vnc-exchange/*
  /api/v1/vnc-viewer/downgrade-to-vnc
  /api/v1/remote/sessions/*/ws
  /api/v1/desktop-ws/*/ws
  /api/v1/tunnel-ws/*/ws
  /api/v1/tunnel-http/*
)

for path in "${remote_paths[@]}"; do
  assert_contains "${REPO_ROOT}/docker/Caddyfile.prod" "${path}"
done
assert_contains "${REPO_ROOT}/docker/Caddyfile.prod" 'REMOTE_ACCESS_ADMISSION_MODE'
assert_contains "${REPO_ROOT}/docker/Caddyfile.prod" 'Retry-After'

# Derive the issuer inventory from production createWsTicket callsites. Any new
# callsite must be classified here and its externally mounted path added to the
# Caddy matcher above, otherwise this contract fails closed.
create_ws_ticket_callsites="$(
  rg -l 'createWsTicket\(' \
    "${REPO_ROOT}/apps/api/src" \
    --glob '*.ts' \
    --glob '!*.test.ts'
)" || fail 'unable to derive createWsTicket callsites'
[[ -n "${create_ws_ticket_callsites}" ]] || fail 'no createWsTicket callsites found'

while IFS= read -r callsite; do
  case "${callsite#${REPO_ROOT}/}" in
    apps/api/src/routes/remote/sessions.ts)
      assert_contains "${callsite}" "'/sessions/:id/ws-ticket'"
      ;;
    apps/api/src/routes/desktopWs.ts)
      assert_contains "${callsite}" "'/:id/viewer/ws-ticket'"
      ;;
    apps/api/src/routes/tunnels.ts)
      assert_contains "${callsite}" "'/:id/ws-ticket'"
      assert_contains "${callsite}" "'/:id/http-ticket'"
      ;;
    apps/api/src/services/remoteSessionAuth.ts)
      ;;
    *)
      fail "unclassified createWsTicket callsite: ${callsite#${REPO_ROOT}/}"
      ;;
  esac
done <<<"${create_ws_ticket_callsites}"

assert_contains "${REPO_ROOT}/apps/api/src/index.ts" "api.route('/remote/sessions', createTerminalWsRoutes"
assert_contains "${REPO_ROOT}/apps/api/src/index.ts" "api.route('/desktop-ws', createDesktopWsRoutes"
assert_contains "${REPO_ROOT}/apps/api/src/index.ts" "api.route('/tunnel-ws', createTunnelWsRoutes"
assert_contains "${REPO_ROOT}/apps/api/src/index.ts" "api.route('/tunnel-http', tunnelHttpRoutes"

for file in \
  "${REPO_ROOT}/.env.example" \
  "${REPO_ROOT}/deploy/.env.example" \
  "${REPO_ROOT}/deploy/compose-config-test.env"; do
  assert_contains "${file}" 'REMOTE_ACCESS_ADMISSION_MODE='
  assert_contains "${file}" 'REMOTE_WS_AUTH_MODE='
  assert_contains "${file}" 'REMOTE_WS_REDIS_TOPOLOGY='
  assert_contains "${file}" 'REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT='
  assert_contains "${file}" 'REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT='
done

for file in \
  "${REPO_ROOT}/docker-compose.yml" \
  "${REPO_ROOT}/deploy/docker-compose.prod.yml"; do
  assert_contains "${file}" 'REMOTE_ACCESS_ADMISSION_MODE:'
  assert_contains "${file}" 'REMOTE_WS_AUTH_MODE:'
  assert_contains "${file}" 'REMOTE_WS_REDIS_TOPOLOGY:'
  assert_contains "${file}" 'REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT:'
  assert_contains "${file}" 'REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT:'
done

for mode in closed open; do
  root_config="$(
    REMOTE_ACCESS_ADMISSION_MODE="${mode}" \
      docker compose \
      --env-file "${REPO_ROOT}/deploy/compose-config-test.env" \
      -f "${REPO_ROOT}/docker-compose.yml" \
      config
  )"
  grep -Fq "REMOTE_ACCESS_ADMISSION_MODE: ${mode}" <<<"${root_config}" \
    || fail "root Compose did not render Caddy/API admission mode ${mode}"

  prod_config="$(
    REMOTE_ACCESS_ADMISSION_MODE="${mode}" \
      docker compose \
      --env-file "${REPO_ROOT}/deploy/compose-config-test.env" \
      -f "${REPO_ROOT}/deploy/docker-compose.prod.yml" \
      config
  )"
  grep -Fq "REMOTE_ACCESS_ADMISSION_MODE: ${mode}" <<<"${prod_config}" \
    || fail "production Compose did not render Caddy/API admission mode ${mode}"
done

assert_contains "${REPO_ROOT}/apps/api/src/routes/tunnelHttp.ts" "tunnelHttpRoutes.all('/:tunnelId/*'"
assert_contains "${REPO_ROOT}/apps/api/src/routes/tunnelHttp.ts" "c.req.query('__bzt')"
assert_contains "${REPO_ROOT}/apps/api/src/routes/tunnelHttp.ts" 'getCookie(c, authCookieName)'

# Exercise the same pure cutover state validator used by deploy.sh with mocked
# process/container/proxy evidence. Sourcing must not execute a deployment.
export BREEZE_DEPLOY_LIBRARY_ONLY=true
# shellcheck source=deploy.sh
source "${REPO_ROOT}/scripts/prod/deploy.sh"
unset BREEZE_DEPLOY_LIBRARY_ONLY

writer_drained_at='2026-07-25T10:00:00.000Z'
viewer_drained_at='2026-07-25T10:00:00.000Z'
writer_ms="$(parse_utc_milliseconds "${writer_drained_at}")"
ws_deadline_ms=$((writer_ms + 60 * 1000))
http_deadline_ms=$((writer_ms + 300 * 1000))
viewer_deadline_ms=$((writer_ms + (7200 + 60) * 1000))

expect_cutover_failure() {
  if validate_remote_access_cutover_state "$@" >/dev/null 2>&1; then
    fail "premature or failed cutover evidence was accepted: $*"
  fi
}

# close -> issuer/upgrade/HTTP probes -> stop/zero -> independent drains ->
# uniform new pool -> reopen. Each missing or premature proof stays closed.
expect_cutover_failure open "${writer_ms}" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 1 post_upgrade
expect_cutover_failure closed "${writer_ms}" "${writer_drained_at}" "${viewer_drained_at}" 0 1 1 1 1 post_upgrade
expect_cutover_failure closed "${writer_ms}" "${writer_drained_at}" "${viewer_drained_at}" 1 0 1 1 1 post_upgrade
expect_cutover_failure closed "${writer_ms}" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 0 post_upgrade
expect_cutover_failure closed "$((ws_deadline_ms - 1))" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 1 post_upgrade
expect_cutover_failure closed "${ws_deadline_ms}" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 1 post_upgrade
expect_cutover_failure closed "$((http_deadline_ms - 1))" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 1 post_upgrade
expect_cutover_failure closed "${http_deadline_ms}" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 0 1 post_upgrade
expect_cutover_failure closed "$((viewer_deadline_ms - 1))" "${writer_drained_at}" "${viewer_drained_at}" 1 1 1 1 1 pre_upgrade

validate_remote_access_cutover_state \
  closed \
  "${http_deadline_ms}" \
  "${writer_drained_at}" \
  "${viewer_drained_at}" \
  1 1 1 1 1 post_upgrade >/dev/null

validate_remote_access_cutover_state \
  closed \
  "${viewer_deadline_ms}" \
  "${writer_drained_at}" \
  "${viewer_drained_at}" \
  1 1 1 1 1 pre_upgrade >/dev/null

echo "[remote-access-cutover.test] PASS"
