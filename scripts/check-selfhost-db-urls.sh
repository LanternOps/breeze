#!/usr/bin/env bash

# Regression guard for the self-host database URLs — for BOTH install paths.
#
# The bundled root docker-compose.yml treats the two DB URLs asymmetrically:
#   - DATABASE_URL      is rebuilt as ...@postgres:5432 INSIDE the api container
#                       (from POSTGRES_USER/PASSWORD/DB), so the .env value never
#                       reaches the API and may point at localhost. (It is inert
#                       under the bundled compose rather than "correct" — that
#                       file publishes no Postgres port, so host-side tooling
#                       cannot reach localhost:5432 either.)
#   - DATABASE_URL_APP  is passed through verbatim (`${DATABASE_URL_APP:-}`), so
#                       whatever the .env holds lands in the api container's
#                       unprivileged request pool.
#
# Both install paths must therefore leave DATABASE_URL_APP empty; the API then
# derives breeze_app@postgres from the container's own DATABASE_URL. A loopback
# value makes the request pool dial the api container's own loopback: migrations
# and ensure-app-role still succeed (they use DATABASE_URL), then startup dies at
# the initial seed with ECONNREFUSED ::1/127.0.0.1:5432.
#
# Two files reach a self-hoster's .env, and BOTH have shipped this bug:
#   1. scripts/guided-setup.sh  — writes the value into the generated .env.
#   2. .env.example             — the `cp .env.example .env` quickstart. Shipped
#                                 an uncommented localhost DATABASE_URL_APP,
#                                 which broke that quickstart path.
# deploy/.env.example feeds deploy/docker-compose.prod.yml, where an explicit
# DATABASE_URL_APP is legitimate (managed Postgres) — it is checked only for
# loopback hosts, not for being set. Only LIVE assignments are inspected there,
# so a commented-out loopback example in that file is deliberately not covered.
#
# DESIGN NOTE — this guard asserts the ABSENCE of other writers, not merely the
# presence of the blessed line. An earlier revision only confirmed that
# `set_env_value "DATABASE_URL_APP" ""` appeared somewhere in guided-setup.sh,
# which meant a commented-out decoy satisfied it while a live `printf >>
# "$ENV_FILE"` or an unquoted-key call wrote a localhost URL past a green CI.
# Every mention of the key must now be either a comment or the exact blessed
# call, so a new writer is a hard failure rather than an unmodelled case.

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

# Every file below is tracked in git and must exist. Treating an absent or
# unreadable file as "nothing to check" is how a guard silently stops guarding,
# so each one is a hard failure.
require_readable() {
  local path="$1"
  [[ -e "${path}" ]] || fail "${path#"${REPO_ROOT}/"} not found. It is tracked in git; a rename or deletion must update this guard."
  [[ -f "${path}" ]] || fail "${path#"${REPO_ROOT}/"} is not a regular file."
  [[ -r "${path}" ]] || fail "${path#"${REPO_ROOT}/"} is not readable."
}

# grep exits 0 (match), 1 (no match), or >1 (I/O error). The bare `if var=$(grep
# ...)` idiom collapses 1 and 2 into "clean", so an unreadable file would read as
# a pass. Always distinguish them.
grep_lines() {
  local pattern="$1" path="$2" out rc
  out="$(grep -nE "${pattern}" "${path}")" && rc=0 || rc=$?
  if [[ "${rc}" -gt 1 ]]; then
    fail "grep failed (exit ${rc}) while scanning ${path#"${REPO_ROOT}/"}; refusing to report a pass."
  fi
  # Always terminate with a newline: `while read` drops a final unterminated
  # line, which would silently skip the last match. An empty `out` yields one
  # blank entry, which every loop below skips.
  printf '%s\n' "${out}"
}

# Strip surrounding single/double quotes and whitespace so `KEY=""` and `KEY=''`
# are recognised as the empty value they are, rather than reported as non-empty.
unquote() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ ${#v} -ge 2 ]]; then
    case "${v}" in
      \"*\") v="${v:1:${#v}-2}" ;;
      \'*\') v="${v:1:${#v}-2}" ;;
    esac
  fi
  printf '%s' "${v}"
}

# Matches a live (non-comment) assignment, with or without a `export ` prefix.
ENV_ASSIGN_RE='^[[:space:]]*(export[[:space:]]+)?DATABASE_URL_APP[[:space:]]*='
# Loopback in any form the api container could be pointed at: localhost, the
# whole 127/8 range (not just 127.0.0.1), the unspecified address, and IPv6 ::1
# with or without brackets.
LOOPBACK_RE='(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|0\.0\.0\.0|\[?::1\]?)'

checks_run=()

# ── 1. guided-setup.sh: the ONLY mention may be one empty set_env_value ──────

require_readable "${SETUP_FILE}"

blessed_re='^[[:space:]]*set_env_value[[:space:]]+"DATABASE_URL_APP"[[:space:]]+""[[:space:]]*$'
blessed_count=0

while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  line_no="${entry%%:*}"
  text="${entry#*:}"

  # A comment can only mislead a human, not write a .env.
  [[ "${text}" =~ ^[[:space:]]*# ]] && continue

  if [[ "${text}" =~ ${blessed_re} ]]; then
    blessed_count=$((blessed_count + 1))
    continue
  fi

  fail "guided-setup.sh:${line_no} mentions DATABASE_URL_APP outside the one blessed assignment: ${text}
The bundled Compose passes DATABASE_URL_APP straight into the api container, so the installer must write it EMPTY and let the API derive breeze_app@postgres. Expected exactly: set_env_value \"DATABASE_URL_APP\" \"\""
done < <(grep_lines 'DATABASE_URL_APP' "${SETUP_FILE}")

if [[ "${blessed_count}" -ne 1 ]]; then
  fail "guided-setup.sh has ${blessed_count} empty DATABASE_URL_APP assignment(s); expected exactly 1 (set_env_value \"DATABASE_URL_APP\" \"\")."
fi
checks_run+=("guided-setup.sh: 1 empty assignment, no other writer")

# ── 2. .env.example: DATABASE_URL_APP must be commented out or empty ─────────
#
# `cp .env.example .env && docker compose up -d` is the documented quickstart,
# so any live value here lands directly in the api container.

require_readable "${ENV_EXAMPLE}"

while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  line_no="${entry%%:*}"
  text="${entry#*:}"
  value="$(unquote "${text#*=}")"
  if [[ -n "${value}" ]]; then
    fail ".env.example:${line_no} sets DATABASE_URL_APP to a non-empty value (${text}).
The bundled Compose passes it straight into the api container, so the quickstart copy must leave it commented out or empty and let the API derive breeze_app@postgres."
  fi
done < <(grep_lines "${ENV_ASSIGN_RE}" "${ENV_EXAMPLE}")
checks_run+=(".env.example: no live non-empty assignment")

# ── 3. deploy/.env.example: explicit value allowed, loopback is not ──────────

require_readable "${DEPLOY_ENV_EXAMPLE}"

while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  line_no="${entry%%:*}"
  text="${entry#*:}"
  value="$(unquote "${text#*=}")"
  if [[ "${value}" =~ ${LOOPBACK_RE} ]]; then
    fail "deploy/.env.example:${line_no} points DATABASE_URL_APP at a loopback host (${text}); the api container would dial its own loopback and fail with ECONNREFUSED."
  fi
done < <(grep_lines "${ENV_ASSIGN_RE}" "${DEPLOY_ENV_EXAMPLE}")
checks_run+=("deploy/.env.example: no loopback assignment")

printf 'self-host DB URL guard passed:\n'
for c in "${checks_run[@]}"; do
  printf '  - %s\n' "${c}"
done
