#!/usr/bin/env bash
#
# guided-setup.sh downloads docker-compose.yml and docker/Caddyfile.prod pinned
# to the SELECTED release tag, but the script itself is whatever the operator
# fetched — usually newer. A script feature that depends on template content
# (the CADDY_LOCAL_CERTS opt-in needs the compose env wiring AND the Caddyfile
# placeholder) is therefore a silent no-op against any tag that predates it:
# the operator answers "n" to the Let's Encrypt prompt, the .env is written,
# and Caddy still fails the ACME order (SSL_ERROR_INTERNAL_ERROR_ALERT).
#
# This guard exercises ensure_caddy_local_certs_template_support against
# templates shaped like a pre-fix release (the current files with the two
# CADDY_LOCAL_CERTS lines stripped), and asserts that:
#   1. both templates gain the wiring, and it lands INSIDE the caddy service /
#      the global options block, not somewhere yaml/caddy would ignore;
#   2. a second run is a no-op (no duplicate lines, no extra backup);
#   3. current templates that already carry the wiring are left untouched
#      (no backup written, bytes identical).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

FUNCTIONS_FILE="${TMP_DIR}/guided-setup-functions.sh"
sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The wiring must exist in the current templates, otherwise "strip it" below
# would be stripping nothing and the legacy fixture would be identical to HEAD.
grep -q 'CADDY_LOCAL_CERTS' "${REPO_ROOT}/docker-compose.yml" \
  || fail "docker-compose.yml no longer wires CADDY_LOCAL_CERTS; this guard's fixture is stale."
grep -q '{\$CADDY_LOCAL_CERTS' "${REPO_ROOT}/docker/Caddyfile.prod" \
  || fail "docker/Caddyfile.prod no longer carries the {\$CADDY_LOCAL_CERTS} placeholder; this guard's fixture is stale."

make_work_dir() {
  local name="$1" legacy="$2"
  local work_dir="${TMP_DIR}/${name}"
  mkdir -p "${work_dir}/docker"
  if [[ "${legacy}" == "true" ]]; then
    grep -v 'CADDY_LOCAL_CERTS' "${REPO_ROOT}/docker-compose.yml" > "${work_dir}/docker-compose.yml"
    grep -v 'CADDY_LOCAL_CERTS' "${REPO_ROOT}/docker/Caddyfile.prod" > "${work_dir}/docker/Caddyfile.prod"
  else
    cp "${REPO_ROOT}/docker-compose.yml" "${work_dir}/docker-compose.yml"
    cp "${REPO_ROOT}/docker/Caddyfile.prod" "${work_dir}/docker/Caddyfile.prod"
  fi
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env.example"
  printf '%s\n' "${work_dir}"
}

run_backfill() {
  local work_dir="$1"
  (
    set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
    # shellcheck source=/dev/null
    source "${FUNCTIONS_FILE}"
    # shellcheck disable=SC2034  # read by ensure_caddy_local_certs_template_support
    REVERSE_PROXY_MODE="caddy"
    ensure_caddy_local_certs_template_support
  )
}

count_backups() {
  local work_dir="$1"
  find "${work_dir}" -name '*.bak.*' | wc -l | tr -d ' '
}

# --- Case 1: legacy templates gain the wiring, in the right place ------------
LEGACY="$(make_work_dir legacy true)"
grep -q 'CADDY_LOCAL_CERTS' "${LEGACY}/docker-compose.yml" && fail "legacy fixture still contains CADDY_LOCAL_CERTS in compose."
grep -q 'CADDY_LOCAL_CERTS' "${LEGACY}/docker/Caddyfile.prod" && fail "legacy fixture still contains CADDY_LOCAL_CERTS in Caddyfile."

run_backfill "${LEGACY}" > "${TMP_DIR}/legacy.log" 2>&1 || {
  cat "${TMP_DIR}/legacy.log" >&2
  fail "ensure_caddy_local_certs_template_support exited non-zero on legacy templates."
}

# Compose: exactly one wiring line, and it sits inside the caddy service's
# environment block (between `  caddy:` and the next top-level service key).
compose_hits="$(grep -c '^      CADDY_LOCAL_CERTS: \${CADDY_LOCAL_CERTS:-}$' "${LEGACY}/docker-compose.yml" || true)"
[[ "${compose_hits}" == "1" ]] || fail "expected exactly one CADDY_LOCAL_CERTS env line in compose, found ${compose_hits}."
awk '
  /^  caddy:[[:space:]]*$/ { in_caddy = 1; next }
  in_caddy && /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ { in_caddy = 0 }
  in_caddy && /^      CADDY_LOCAL_CERTS: / { found = 1 }
  END { exit found ? 0 : 1 }
' "${LEGACY}/docker-compose.yml" || fail "CADDY_LOCAL_CERTS env line is not inside the caddy service."

# Caddyfile: exactly one placeholder, inside the global options block that
# opens the file (the first line that is a bare `{`).
caddy_hits="$(grep -c '^  {\$CADDY_LOCAL_CERTS}$' "${LEGACY}/docker/Caddyfile.prod" || true)"
[[ "${caddy_hits}" == "1" ]] || fail "expected exactly one {\$CADDY_LOCAL_CERTS} placeholder in Caddyfile, found ${caddy_hits}."
awk '
  !opened && /^\{[[:space:]]*$/ { opened = 1; next }
  opened && /^\}[[:space:]]*$/ { opened = 0; closed = 1 }
  opened && !closed && /^  \{\$CADDY_LOCAL_CERTS\}$/ { found = 1 }
  END { exit found ? 0 : 1 }
' "${LEGACY}/docker/Caddyfile.prod" || fail "{\$CADDY_LOCAL_CERTS} placeholder is not inside the global options block."

[[ "$(count_backups "${LEGACY}")" == "2" ]] || fail "expected one backup per rewritten template (2), found $(count_backups "${LEGACY}")."

# The patched templates must match what HEAD ships, modulo comment lines, so
# the backfill cannot drift from the real wiring.
diff <(grep -v '^\s*#' "${LEGACY}/docker/Caddyfile.prod") <(grep -v '^\s*#' "${REPO_ROOT}/docker/Caddyfile.prod") \
  || fail "backfilled Caddyfile differs from HEAD's Caddyfile outside comments."
diff <(grep -v '^\s*#' "${LEGACY}/docker-compose.yml") <(grep -v '^\s*#' "${REPO_ROOT}/docker-compose.yml") \
  || fail "backfilled compose differs from HEAD's compose outside comments."

# --- Case 2: second run is a no-op ------------------------------------------
cp "${LEGACY}/docker-compose.yml" "${TMP_DIR}/legacy-compose.once"
cp "${LEGACY}/docker/Caddyfile.prod" "${TMP_DIR}/legacy-caddy.once"
run_backfill "${LEGACY}" > /dev/null 2>&1 || fail "second run exited non-zero."
cmp -s "${LEGACY}/docker-compose.yml" "${TMP_DIR}/legacy-compose.once" || fail "second run modified compose."
cmp -s "${LEGACY}/docker/Caddyfile.prod" "${TMP_DIR}/legacy-caddy.once" || fail "second run modified Caddyfile."
[[ "$(count_backups "${LEGACY}")" == "2" ]] || fail "second run wrote an extra backup."

# --- Case 3: current templates untouched ------------------------------------
CURRENT="$(make_work_dir current false)"
run_backfill "${CURRENT}" > /dev/null 2>&1 || fail "run against current templates exited non-zero."
cmp -s "${CURRENT}/docker-compose.yml" "${REPO_ROOT}/docker-compose.yml" || fail "current compose was modified."
cmp -s "${CURRENT}/docker/Caddyfile.prod" "${REPO_ROOT}/docker/Caddyfile.prod" || fail "current Caddyfile was modified."
[[ "$(count_backups "${CURRENT}")" == "0" ]] || fail "backup written although current templates needed no change."

printf 'guided setup CADDY_LOCAL_CERTS template backfill guard passed\n'
