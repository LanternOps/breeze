#!/usr/bin/env bash

# End-to-end smoke of the self-host guided installer (scripts/guided-setup.sh)
# on a real Linux host with Docker and systemd — what CI's ubuntu runner is, and
# what a self-hoster's box is.
#
# Why this exists
# ---------------
# The installer's failure modes only ever surfaced on customers' machines,
# because nothing ran it end to end before release:
#   - the systemd reboot-startup unit was rejected with "bad unit file setting"
#     twice under #4201 (Type=oneshot + Restart=, then a quoted WorkingDirectory=)
#     — `systemctl enable --now` was never executed anywhere but on a self-hoster's
#     host;
#   - the quickstart's own "reach it from another machine" recipe
#     (BREEZE_DOMAIN=localhost + `ssh -L 8443:127.0.0.1:443`, browse
#     https://localhost:8443) produced a browser origin outside the generated
#     CORS_ALLOWED_ORIGINS, so POST /auth/refresh 403'd, cleared the refresh
#     cookie, and every login bounced straight back to /login?reason=session-expired.
#
# What it does
# ------------
# Runs the REAL installer non-interactively (`--yes`) against this checkout's
# templates and locally built images, then asserts the things a self-hoster
# would hit in the first ten minutes: the stack is healthy through the packaged
# Caddy, the bootstrap admin can sign in, a fresh session survives a page load
# through the documented SSH-tunnel topology (a local socat forward stands in
# for `ssh -L`), and the systemd unit the installer installed actually
# enables, starts, stops the stack, and starts it again.
#
# Usage
# -----
#   scripts/smoke-guided-setup.sh            run the smoke (exit 1 on any failure)
#   scripts/smoke-guided-setup.sh logs       dump unit/journal/compose logs (for CI on failure)
#   scripts/smoke-guided-setup.sh teardown   disable the unit, remove the stack + volumes
#
# Inputs (env):
#   GUIDED_SMOKE_VERSION             image tag the installer will use (default ci-smoke).
#                                    ghcr.io/lanternops/breeze/{api,web,portal}:<tag> must
#                                    exist locally (CI builds them from this checkout).
#   GUIDED_SMOKE_BINARIES_IMAGE_REF  agent binaries image (default ghcr.io/lanternops/breeze/binaries:latest)
#   GUIDED_SMOKE_WORK_DIR            installer work dir (default $HOME/breeze-guided-smoke)
#   GUIDED_SMOKE_TUNNEL_PORT         local port for the tunnel simulation (default 8443)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WORK_DIR="${GUIDED_SMOKE_WORK_DIR:-${HOME}/breeze-guided-smoke}"
VERSION="${GUIDED_SMOKE_VERSION:-ci-smoke}"
BINARIES_IMAGE_REF="${GUIDED_SMOKE_BINARIES_IMAGE_REF:-ghcr.io/lanternops/breeze/binaries:latest}"
TUNNEL_PORT="${GUIDED_SMOKE_TUNNEL_PORT:-8443}"
ADMIN_EMAIL="ci-admin@breeze.local"
# Fixed so CI can mask it before the installer prints it. Must satisfy the
# production bootstrap rules in apps/api/src/db/seed.ts (>= 16 chars, not a
# dictionary-looking value) — same string the Smoke Test job already uses.
ADMIN_PASSWORD="ci-smoke-bootstrap-credential-32-chars"
SERVICE="breeze-rmm.service"
CSRF_COOKIE="breeze_csrf_token"
CSRF_HEADER="x-breeze-csrf"
BASE="https://localhost"
TUNNEL_ORIGIN="https://localhost:${TUNNEL_PORT}"

STEP=0
SOCAT_PID=""

step() {
  STEP=$((STEP + 1))
  printf '\n=== [%d] %s ===\n' "${STEP}" "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose -f "${WORK_DIR}/docker-compose.yml" --env-file "${WORK_DIR}/.env" "$@"
}

cleanup() {
  if [[ -n "${SOCAT_PID}" ]]; then
    kill "${SOCAT_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- subcommands -------------------------------------------------------------

do_logs() {
  echo "=== systemctl status ${SERVICE} ==="
  systemctl status "${SERVICE}" --no-pager -l 2>&1 || true
  echo "=== journalctl -u ${SERVICE} ==="
  sudo journalctl -u "${SERVICE}" --no-pager -l 2>&1 | tail -100 || true
  echo "=== systemd-analyze verify ==="
  systemd-analyze verify "/etc/systemd/system/${SERVICE}" 2>&1 || true
  echo "=== installed unit ==="
  cat "/etc/systemd/system/${SERVICE}" 2>/dev/null || true
  echo "=== docker ps ==="
  docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1 || true
  if [[ -f "${WORK_DIR}/docker-compose.yml" && -f "${WORK_DIR}/.env" ]]; then
    echo "=== docker compose logs (tail) ==="
    compose logs --tail=200 2>&1 || true
  fi
  echo "=== installer log ==="
  tail -80 "${WORK_DIR}/guided-setup.log" 2>/dev/null || true
}

do_teardown() {
  sudo systemctl disable --now "${SERVICE}" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${SERVICE}"
  sudo rm -rf /usr/local/lib/breeze-rmm
  sudo systemctl daemon-reload 2>/dev/null || true
  if [[ -f "${WORK_DIR}/docker-compose.yml" && -f "${WORK_DIR}/.env" ]]; then
    compose down -v --remove-orphans 2>/dev/null || true
  fi
}

case "${1:-run}" in
  logs) do_logs; exit 0 ;;
  teardown) do_teardown; exit 0 ;;
  run) ;;
  *) echo "Usage: $0 [run|logs|teardown]" >&2; exit 2 ;;
esac

# --- helpers -----------------------------------------------------------------

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

wait_for_api_healthy() {
  local deadline=$(( $(date +%s) + ${1:-180} )) status
  while (( $(date +%s) < deadline )); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' breeze-api 2>/dev/null || true)"
    if [[ "${status}" == "healthy" ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# curl against the self-signed (Caddy internal CA) localhost cert.
http() {
  curl -sk --max-time 30 "$@"
}

csrf_from_jar() {
  awk -v name="${CSRF_COOKIE}" '$6 == name { print $7 }' "$1" | tail -1
}

# login <jar> <origin> -> prints access token
login() {
  local jar="$1" origin="$2" body
  body="$(http -c "${jar}" -X POST "${origin}/api/v1/auth/login" \
    -H 'Content-Type: application/json' -H "Origin: ${origin}" \
    --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")" \
    || fail "login request to ${origin} failed"
  jq -er '.tokens.accessToken' <<<"${body}" 2>/dev/null \
    || fail "login at ${origin} returned no access token: $(jq -c 'del(.tokens)' <<<"${body}" 2>/dev/null || echo "${body}")"
}

# refresh <jar> <origin> <label> [extra curl args...] -> asserts 200 + token
refresh() {
  local jar="$1" origin="$2" label="$3"
  shift 3
  local csrf status body
  csrf="$(csrf_from_jar "${jar}")"
  [[ -n "${csrf}" ]] || fail "${label}: no ${CSRF_COOKIE} cookie in jar"
  body="$(http -b "${jar}" -c "${jar}" -o /dev/stdout -w '\n%{http_code}' -X POST "${origin}/api/v1/auth/refresh" \
    -H 'Content-Type: application/json' -H "Origin: ${origin}" -H "${CSRF_HEADER}: ${csrf}" "$@")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "${status}" != "200" ]]; then
    fail "${label}: POST /auth/refresh returned ${status}: ${body}"
  fi
  jq -e '.tokens.accessToken' >/dev/null <<<"${body}" || fail "${label}: refresh returned no access token: ${body}"
  echo "  OK  ${label}"
}

# --- run ---------------------------------------------------------------------

step "Preflight"
require docker
require systemctl
require curl
require jq
require socat
sudo -n true 2>/dev/null || fail "passwordless sudo is required (the installer installs a systemd unit)"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
for image in api web portal; do
  docker image inspect "ghcr.io/lanternops/breeze/${image}:${VERSION}" >/dev/null 2>&1 \
    || fail "ghcr.io/lanternops/breeze/${image}:${VERSION} is not present locally — build it first"
done
if systemctl list-unit-files "${SERVICE}" 2>/dev/null | grep -q "^${SERVICE}"; then
  fail "${SERVICE} is already installed on this host; run '$0 teardown' first"
fi
if docker ps -a --format '{{.Names}}' | grep -qE '^breeze-(api|web|portal|caddy|postgres|redis|binaries-init)$'; then
  fail "breeze-* containers already exist on this host; run '$0 teardown' first"
fi
echo "  OK  host has docker, systemd, sudo, socat, and the ${VERSION} images"

step "Stage the installer inputs in ${WORK_DIR} (this checkout's templates)"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/docker"
cp "${REPO_ROOT}/docker-compose.yml" "${REPO_ROOT}/.env.example" "${WORK_DIR}/"
cp "${REPO_ROOT}/docker/Caddyfile.prod" "${WORK_DIR}/docker/"
cp "${REPO_ROOT}/scripts/guided-setup.sh" "${WORK_DIR}/guided-setup.sh"
chmod +x "${WORK_DIR}/guided-setup.sh"
# Seed exactly what a self-hoster would have to type: the version (pinned to the
# locally built images) and the bootstrap admin. Everything else is the
# installer's own defaults and generated secrets.
cp "${WORK_DIR}/.env.example" "${WORK_DIR}/.env"
chmod 600 "${WORK_DIR}/.env"
sed -i \
  -e "s|^BREEZE_VERSION=.*|BREEZE_VERSION=${VERSION}|" \
  -e "s|^BREEZE_BOOTSTRAP_ADMIN_EMAIL=.*|BREEZE_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}|" \
  -e "s|^BREEZE_BOOTSTRAP_ADMIN_PASSWORD=.*|BREEZE_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}|" \
  -e "s|^BREEZE_BINARIES_IMAGE_REF=.*|BREEZE_BINARIES_IMAGE_REF=${BINARIES_IMAGE_REF}|" \
  "${WORK_DIR}/.env"
echo "  OK  staged"

step "Run scripts/guided-setup.sh --yes end to end (generate, pull, up, health wait, systemd install)"
# BREEZE_SETUP_GITHUB_API points at a closed port so the run never depends on
# GitHub being reachable; BREEZE_SETUP_VERSION pins the locally built tag.
# `docker compose pull` will fail for the local-only api/web/portal tags — the
# installer treats that as non-fatal and starts from local images, which is
# exactly the documented "bring your own images" path.
set +e
(
  cd "${WORK_DIR}" \
  && BREEZE_SETUP_VERSION="${VERSION}" \
     BREEZE_SETUP_SECRET_MODE=auto \
     BREEZE_SETUP_STORAGE_MODE=docker \
     BREEZE_SETUP_INSTALL_SYSTEMD=true \
     BREEZE_SETUP_DRY_RUN=false \
     BREEZE_SETUP_GITHUB_API=http://127.0.0.1:9 \
     ./guided-setup.sh --no-download --yes < /dev/null
) 2>&1 | tee "${WORK_DIR}/guided-setup.log"
installer_status=${PIPESTATUS[0]}
set -e
[[ "${installer_status}" -eq 0 ]] || fail "guided-setup.sh exited ${installer_status} (see log above)"
echo "  OK  installer exited 0"

step "Assert the M365 JWK secret placeholder exists (#2991 — bare install dir, not a full checkout)"
# This WORK_DIR only ever gets docker-compose.yml + .env.example + (in
# packaged-Caddy mode) docker/Caddyfile.prod staged into it above — it is
# never a full repo clone. docker-compose.yml's M365 executor signing-key
# secrets default their file: source to ./docker/secrets/.empty-jwk when
# unset, so the installer itself must create that file (it is not part of
# what gets staged/downloaded); otherwise `docker compose up` fails with
# "bind source path does not exist" instead of starting. If this regresses,
# the installer run above would already have failed on the api container
# never starting — this step exists to name the exact cause instead of
# leaving it to a bisect through installer output.
placeholder="${WORK_DIR}/docker/secrets/.empty-jwk"
[[ -f "${placeholder}" ]] || fail "installer did not create ${placeholder}"
[[ ! -s "${placeholder}" ]] || fail "${placeholder} is not empty"
echo "  OK  ${placeholder} exists and is empty"

step "Assert the generated .env"
grep -q "^BREEZE_VERSION=${VERSION}\$" "${WORK_DIR}/.env" || fail "BREEZE_VERSION was not pinned to ${VERSION}"
grep -q '^BREEZE_DOMAIN=localhost$' "${WORK_DIR}/.env" || fail "BREEZE_DOMAIN default is not localhost"
grep -q '^CORS_ALLOWED_ORIGINS=https://localhost$' "${WORK_DIR}/.env" \
  || fail "CORS_ALLOWED_ORIGINS is not the documented default (https://localhost); the tunnel assertion below would not prove anything"
grep -q '^FORCE_HTTPS=true$' "${WORK_DIR}/.env" || fail "packaged-Caddy mode should set FORCE_HTTPS=true"
echo "  OK  BREEZE_VERSION=${VERSION}, BREEZE_DOMAIN=localhost, CORS_ALLOWED_ORIGINS=https://localhost"

step "Assert the reboot-startup unit the installer installed is enabled and active (#4201)"
enabled="$(systemctl is-enabled "${SERVICE}" 2>&1 || true)"
[[ "${enabled}" == "enabled" ]] || fail "${SERVICE} is-enabled: ${enabled}"
active="$(systemctl is-active "${SERVICE}" 2>&1 || true)"
[[ "${active}" == "active" ]] || fail "${SERVICE} is-active: ${active} (systemctl status: $(systemctl status "${SERVICE}" --no-pager 2>&1 | head -5 | tr '\n' ' '))"
systemd-analyze verify "/etc/systemd/system/${SERVICE}" || fail "systemd-analyze verify rejected the installed unit"
echo "  OK  ${SERVICE} enabled + active, unit verifies"

step "Assert the stack is healthy through the packaged Caddy (${BASE})"
wait_for_api_healthy 180 || fail "breeze-api never reported healthy"
health_status="$(http -o /dev/null -w '%{http_code}' "${BASE}/health")"
[[ "${health_status}" == "200" ]] || fail "GET ${BASE}/health returned ${health_status}"
web_status="$(http -o /dev/null -w '%{http_code}' "${BASE}/login")"
[[ "${web_status}" == "200" ]] || fail "GET ${BASE}/login returned ${web_status}"
echo "  OK  /health and /login are 200 over HTTPS"

step "Bootstrap admin login at the configured origin (${BASE})"
jar_direct="$(mktemp)"
token="$(login "${jar_direct}" "${BASE}")"
me_status="$(http -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" "${BASE}/api/v1/users/me")"
[[ "${me_status}" == "200" ]] || fail "GET /users/me with the bootstrap session returned ${me_status}"
refresh "${jar_direct}" "${BASE}" "refresh at the configured origin" -H 'Sec-Fetch-Site: same-origin'
echo "  OK  bootstrap admin can sign in and refresh"

step "Documented SSH-tunnel topology: browse ${TUNNEL_ORIGIN} while CORS_ALLOWED_ORIGINS=https://localhost"
# socat stands in for `ssh -L ${TUNNEL_PORT}:127.0.0.1:443 user@server` — the
# browser then sends Origin/Host ${TUNNEL_ORIGIN}, which is outside the allowlist.
socat "TCP-LISTEN:${TUNNEL_PORT},bind=127.0.0.1,fork,reuseaddr" TCP:127.0.0.1:443 &
SOCAT_PID=$!
sleep 1
kill -0 "${SOCAT_PID}" 2>/dev/null || fail "socat tunnel on ${TUNNEL_PORT} did not start"
jar_tunnel="$(mktemp)"
login "${jar_tunnel}" "${TUNNEL_ORIGIN}" >/dev/null
# A real browser sends both; the first proves the Fetch-Metadata path, the
# second (rotated cookie, no Sec-Fetch-Site) proves Origin == Host through the
# tunnel. Before #4475 both returned 403 "Invalid request origin" and cleared
# the cookie, which is the endless session-expired loop self-hosters reported.
refresh "${jar_tunnel}" "${TUNNEL_ORIGIN}" "refresh via tunnel (Sec-Fetch-Site: same-origin)" -H 'Sec-Fetch-Site: same-origin'
refresh "${jar_tunnel}" "${TUNNEL_ORIGIN}" "refresh via tunnel (Origin == Host, no fetch metadata)"
kill "${SOCAT_PID}" 2>/dev/null || true
SOCAT_PID=""
echo "  OK  a session survives page loads through the tunnel"

step "Reboot path: the systemd unit stops and restarts the whole stack"
sudo systemctl stop "${SERVICE}" || fail "systemctl stop ${SERVICE} failed"
if docker ps --format '{{.Names}}' | grep -qE '^breeze-'; then
  fail "containers still running after systemctl stop: $(docker ps --format '{{.Names}}' | grep -E '^breeze-' | tr '\n' ' ')"
fi
echo "  OK  stop brought the stack down"
sudo systemctl start "${SERVICE}" || fail "systemctl start ${SERVICE} failed"
wait_for_api_healthy 240 || fail "breeze-api never reported healthy after systemctl start"
health_status="$(http -o /dev/null -w '%{http_code}' "${BASE}/health")"
[[ "${health_status}" == "200" ]] || fail "GET ${BASE}/health after restart returned ${health_status}"
active="$(systemctl is-active "${SERVICE}" 2>&1 || true)"
[[ "${active}" == "active" ]] || fail "${SERVICE} is-active after restart: ${active}"
echo "  OK  start brought the stack back and the unit stays active"

printf '\nguided-setup smoke: ALL %d STEPS PASSED\n' "${STEP}"
