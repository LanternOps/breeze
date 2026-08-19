#!/usr/bin/env bash

# Regression guard for the self-host database URLs — for BOTH install paths.
#
# The bundled root docker-compose.yml treats the two DB URLs asymmetrically:
#   - DATABASE_URL      is rebuilt as ...@postgres:5432 INSIDE the api container
#                       (from POSTGRES_USER/PASSWORD/DB); the .env value is only
#                       for host-side tooling and may point at localhost.
#   - DATABASE_URL_APP  is passed straight through (`${DATABASE_URL_APP:-}`), so
#                       whatever the .env holds lands verbatim in the
#                       container's unprivileged request pool.
#
# Therefore both install paths MUST leave DATABASE_URL_APP empty (the API then
# derives breeze_app@postgres from the container DATABASE_URL). A localhost
# value makes the request pool dial 127.0.0.1 inside the container: migrations
# and ensure-app-role still succeed (they use DATABASE_URL), then startup
# crashes at the initial seed with ECONNREFUSED ::1/127.0.0.1:5432.
#
# Two files reach a self-hoster's .env, and BOTH have shipped this bug:
#   1. scripts/guided-setup.sh  — writes the value via set_env_value.
#   2. .env.example             — the `cp .env.example .env` quickstart. Shipped
#                                 an uncommented localhost DATABASE_URL_APP,
#                                 which broke every from-scratch quickstart
#                                 install until it was commented out.
# deploy/.env.example feeds deploy/docker-compose.prod.yml, where an explicit
# DATABASE_URL_APP is legitimate (managed Postgres) — it is checked only for
# loopback hosts, not for being set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP_FILE="${REPO_ROOT}/scripts/guided-setup.sh"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
DEPLOY_ENV_EXAMPLE="${REPO_ROOT}/deploy/.env.example"

fail() {
  printf 'check-selfhost-db-urls: %s\n' "$1" >&2
  exit 1
}

# ── 1. guided-setup.sh: exactly one, empty, set_env_value assignment ─────────

[[ -f "${SETUP_FILE}" ]] || fail "guided-setup.sh not found at ${SETUP_FILE}"

# Collect every literal value the installer assigns to DATABASE_URL_APP via
# set_env_value. Match: set_env_value "DATABASE_URL_APP" "<value>"
assignment_count=0
while IFS= read -r value; do
  assignment_count=$((assignment_count + 1))
  if [[ -n "${value}" ]]; then
    fail "guided-setup.sh: DATABASE_URL_APP is assigned a non-empty value (\"${value}\"). The bundled Compose passes DATABASE_URL_APP straight into the api container, so it MUST be empty and derived from the container's @postgres DATABASE_URL."
  fi
done < <(
  grep -oE 'set_env_value[[:space:]]+"DATABASE_URL_APP"[[:space:]]+"[^"]*"' "${SETUP_FILE}" \
    | sed -E 's/.*"DATABASE_URL_APP"[[:space:]]+"([^"]*)".*/\1/'
)

if [[ "${assignment_count}" -eq 0 ]]; then
  fail "guided-setup.sh: no set_env_value \"DATABASE_URL_APP\" ... assignment found; expected exactly one empty assignment."
fi

# Belt-and-suspenders: no DATABASE_URL_APP assignment anywhere should reference a
# loopback host.
if grep -nE 'set_env_value[[:space:]]+"DATABASE_URL_APP".*(localhost|127\.0\.0\.1|::1)' "${SETUP_FILE}"; then
  fail "guided-setup.sh: DATABASE_URL_APP assignment references a loopback host; it would dial the api container's own loopback and fail with ECONNREFUSED."
fi

# ── 2. .env.example: DATABASE_URL_APP must be commented out or empty ─────────
#
# `cp .env.example .env && docker compose up -d` is the documented quickstart,
# so any uncommented value here lands directly in the api container.

[[ -f "${ENV_EXAMPLE}" ]] || fail ".env.example not found at ${ENV_EXAMPLE}"

if active_line="$(grep -nE '^[[:space:]]*DATABASE_URL_APP[[:space:]]*=[[:space:]]*[^[:space:]]' "${ENV_EXAMPLE}")"; then
  fail ".env.example sets DATABASE_URL_APP to a non-empty value (${active_line}). The bundled Compose passes it straight into the api container, so the quickstart copy MUST leave it commented out or empty and let the API derive breeze_app@postgres."
fi

# ── 3. deploy/.env.example: explicit value allowed, loopback is not ──────────

if [[ -f "${DEPLOY_ENV_EXAMPLE}" ]]; then
  if loopback_line="$(grep -nE '^[[:space:]]*DATABASE_URL_APP[[:space:]]*=.*(localhost|127\.0\.0\.1|\[?::1\]?)' "${DEPLOY_ENV_EXAMPLE}")"; then
    fail "deploy/.env.example sets DATABASE_URL_APP to a loopback host (${loopback_line}); the api container would dial its own loopback and fail with ECONNREFUSED."
  fi
fi

printf 'self-host DB URL guard passed (guided-setup: %d empty DATABASE_URL_APP assignment(s); .env.example: not set)\n' "${assignment_count}"
