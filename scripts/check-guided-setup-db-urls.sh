#!/usr/bin/env bash

# Regression guard for the guided installer's generated database URLs.
#
# The bundled root docker-compose.yml treats the two DB URLs asymmetrically:
#   - DATABASE_URL      is rebuilt as ...@postgres:5432 INSIDE the api container
#                       (from POSTGRES_USER/PASSWORD/DB); the .env value is only
#                       for host-side tooling and may point at localhost.
#   - DATABASE_URL_APP  is passed straight through (`${DATABASE_URL_APP:-}`), so
#                       whatever the installer writes lands verbatim in the
#                       container's unprivileged request pool.
#
# Therefore the installer MUST leave DATABASE_URL_APP empty (the API then derives
# breeze_app@postgres from the container DATABASE_URL). Writing a localhost value
# made the request pool dial 127.0.0.1 inside the container and crash at seed
# with ECONNREFUSED. This guard fails if that regresses.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP_FILE="${REPO_ROOT}/scripts/guided-setup.sh"

fail() {
  printf 'check-guided-setup-db-urls: %s\n' "$1" >&2
  exit 1
}

[[ -f "${SETUP_FILE}" ]] || fail "guided-setup.sh not found at ${SETUP_FILE}"

# Collect every literal value the installer assigns to DATABASE_URL_APP via
# set_env_value. Match: set_env_value "DATABASE_URL_APP" "<value>"
# (bash 3.2-compatible: no mapfile — macOS ships bash 3.2.)
assignment_count=0
while IFS= read -r value; do
  assignment_count=$((assignment_count + 1))
  if [[ -n "${value}" ]]; then
    fail "DATABASE_URL_APP is assigned a non-empty value (\"${value}\"). The bundled Compose passes DATABASE_URL_APP straight into the api container, so it MUST be empty and derived from the container's @postgres DATABASE_URL. See scripts/guided-setup.sh."
  fi
done < <(
  grep -oE 'set_env_value[[:space:]]+"DATABASE_URL_APP"[[:space:]]+"[^"]*"' "${SETUP_FILE}" \
    | sed -E 's/.*"DATABASE_URL_APP"[[:space:]]+"([^"]*)".*/\1/'
)

if [[ "${assignment_count}" -eq 0 ]]; then
  fail "no set_env_value \"DATABASE_URL_APP\" ... assignment found; expected exactly one empty assignment."
fi

# Belt-and-suspenders: no DATABASE_URL_APP assignment anywhere should reference a
# loopback host, even if it were built from a variable in the future.
if grep -nE 'set_env_value[[:space:]]+"DATABASE_URL_APP".*(localhost|127\.0\.0\.1|::1)' "${SETUP_FILE}"; then
  fail "DATABASE_URL_APP assignment references a loopback host; it would dial the api container's own loopback and fail with ECONNREFUSED."
fi

# The installer must never override the compose secure default of trusting the
# pinned bundled-Caddy peer. Writing TRUST_PROXY_HEADERS=false makes the API
# attribute every request to Caddy's container IP, collapsing per-IP rate
# limiting and IP allowlists (SR2-16; apps/api/src/config/proxyTrustCompose.test.ts).
if grep -nE 'set_env_value[[:space:]]+"TRUST_PROXY_HEADERS"[[:space:]]+"false"' "${SETUP_FILE}"; then
  fail "installer sets TRUST_PROXY_HEADERS=false, defeating real-client-IP trust for the bundled Caddy peer. It must be true (or unset so compose defaults true)."
fi

printf 'guided setup DB URL guard passed (%d DATABASE_URL_APP assignment(s), all empty)\n' "${assignment_count}"
