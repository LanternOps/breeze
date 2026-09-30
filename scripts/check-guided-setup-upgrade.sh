#!/usr/bin/env bash

# Behavioral guard for `scripts/guided-setup.sh --upgrade` (#7024).
#
# Why this guard exists
# ----------------------
# A guided install at or above SIGNED_IMAGE_INVENTORY_MIN_VERSION pins its
# first-party images by digest, so `docker compose pull` never upgrades it and
# a hand-edited BREEZE_VERSION leaves the old digests running while /health
# and the agent fleet follow the new value. --upgrade is the supported path.
#
# The signed happy path (real Ed25519 inventory, digests rewritten together
# with BREEZE_VERSION, .env backed up, tampered inventory leaves .env
# untouched) lives in scripts/release/release-image-consumers.test.mjs, which
# owns the signing fixture. This guard covers what needs no crypto or network,
# and proves every refusal leaves .env byte-for-byte unchanged:
#   1. a target below the signed-image floor is refused (no unsigned upgrade);
#   2. a non-release target or current BREEZE_VERSION is refused;
#   3. a downgrade is refused without --allow-downgrade;
#   4. --upgrade without an existing .env / docker-compose.yml is refused;
#   5. `--upgrade -y` does not swallow -y as the target version,
#      --allow-downgrade is rejected without --upgrade, and
#      --allow-unverified-release is rejected with --upgrade;
#   6. the installer's closing output tells the operator how to upgrade.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP="${REPO_ROOT}/scripts/guided-setup.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

FLOOR="$(
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${SETUP}"
  printf '%s' "${SIGNED_IMAGE_INVENTORY_MIN_VERSION}"
)"
[[ -n "${FLOOR}" ]] || fail "SIGNED_IMAGE_INVENTORY_MIN_VERSION is not set"

new_install() {
  local name="$1" version="$2" dir
  dir="${TMP_DIR}/${name}"
  mkdir -p "${dir}"
  printf 'services: {}\n' > "${dir}/docker-compose.yml"
  cat > "${dir}/.env" <<EOF
BREEZE_VERSION=${version}
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=AAAA
BREEZE_API_IMAGE_REF=ghcr.io/lanternops/breeze/api@sha256:$(printf '0%.0s' {1..64})
POSTGRES_PASSWORD=keep-me
EOF
  chmod 600 "${dir}/.env"
  printf '%s' "${dir}"
}

# Runs --upgrade and asserts it FAILS with a message matching $2 and leaves
# .env unchanged with no backup or staged copy. BREEZE_SETUP_RELEASE_DOWNLOAD_BASE
# points at a directory with no inventory, so anything that got past the
# refusals would fail closed rather than reach the network.
expect_refused() {
  local dir="$1" pattern="$2"
  shift 2
  local before output status=0
  before="$(cat "${dir}/.env")"
  output="$(
    BREEZE_SETUP_RELEASE_DOWNLOAD_BASE="file://${TMP_DIR}/no-inventory" \
      bash "${SETUP}" --work-dir "${dir}" --no-up -y "$@" 2>&1
  )" || status=$?
  [[ "${status}" -ne 0 ]] || fail "expected '$*' to be refused; it succeeded:\n${output}"
  grep -Eq "${pattern}" <<< "${output}" || fail "expected '$*' to report /${pattern}/; got:\n${output}"
  [[ "$(cat "${dir}/.env")" == "${before}" ]] || fail "'$*' changed ${dir}/.env despite refusing"
  if compgen -G "${dir}/.env.*" >/dev/null; then
    fail "'$*' left a backup or staged .env copy behind: $(ls -a "${dir}")"
  fi
}

# --- 1. no unsigned upgrade --------------------------------------------------
dir="$(new_install below-floor "${FLOOR}")"
expect_refused "${dir}" "signed image inventory" --upgrade 0.111.0 --allow-downgrade
echo "  OK  --upgrade refuses a target below the signed-image floor (${FLOOR})"

# --- 2. exact release versions only -----------------------------------------
dir="$(new_install bad-target "${FLOOR}")"
expect_refused "${dir}" "not an exact release version" --upgrade latest
dir="$(new_install bad-current "dev")"
expect_refused "${dir}" "not an exact release version" --upgrade "${FLOOR}"
echo "  OK  --upgrade refuses a non-release target or current BREEZE_VERSION"

# --- 3. downgrade ------------------------------------------------------------
dir="$(new_install downgrade "9999.0.0")"
expect_refused "${dir}" "Refusing to downgrade" --upgrade "${FLOOR}"
echo "  OK  --upgrade refuses a downgrade without --allow-downgrade"

# --- 4. existing install required -------------------------------------------
dir="${TMP_DIR}/empty"
mkdir -p "${dir}"
printf 'services: {}\n' > "${dir}/docker-compose.yml"
status=0
output="$(bash "${SETUP}" --work-dir "${dir}" --no-up -y --upgrade "${FLOOR}" 2>&1)" || status=$?
[[ "${status}" -ne 0 ]] && grep -q "updates an existing install" <<< "${output}" \
  || fail "--upgrade without .env must refuse; got status ${status}:\n${output}"
[[ ! -e "${dir}/.env" ]] || fail "--upgrade without .env must not create one"
dir="$(new_install no-compose "${FLOOR}")"
rm -f "${dir}/docker-compose.yml"
expect_refused "${dir}" "Missing .*docker-compose.yml" --upgrade "${FLOOR}"
echo "  OK  --upgrade refuses to run without an existing .env and docker-compose.yml"

# --- 5. argument parsing -----------------------------------------------------
(
  set -- --upgrade -y
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${SETUP}" >/dev/null
  [[ "${UPGRADE_MODE}" == "true" && -z "${UPGRADE_TARGET_VERSION}" && "${YES_MODE}" == "true" ]] \
    || fail "--upgrade -y must mean 'latest release, unattended', not target '-y'"
)
(
  set -- --upgrade v0.116.0 --no-up
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${SETUP}" >/dev/null
  [[ "${UPGRADE_TARGET_VERSION}" == "v0.116.0" && "${NO_UP}" == "true" ]] \
    || fail "--upgrade VERSION must capture the version argument"
)
status=0
output="$(bash "${SETUP}" --allow-downgrade --work-dir "${TMP_DIR}/unused" 2>&1)" || status=$?
[[ "${status}" -eq 2 ]] && grep -q "only applies to --upgrade" <<< "${output}" \
  || fail "--allow-downgrade without --upgrade must be a usage error; got status ${status}:\n${output}"
# --upgrade has no unverified path: the install-time override must not be
# silently accepted (and ignored) next to it.
dir="$(new_install unverified-override "${FLOOR}")"
before="$(cat "${dir}/.env")"
status=0
output="$(bash "${SETUP}" --work-dir "${dir}" --no-up -y --upgrade 0.111.0 --allow-unverified-release 2>&1)" || status=$?
[[ "${status}" -eq 2 ]] && grep -q "does not apply to --upgrade" <<< "${output}" \
  || fail "--allow-unverified-release with --upgrade must be a usage error; got status ${status}:\n${output}"
[[ "$(cat "${dir}/.env")" == "${before}" ]] || fail "--upgrade --allow-unverified-release changed ${dir}/.env"
echo "  OK  --upgrade argument parsing"

# --- 6. installer tells the operator how to upgrade --------------------------
(
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${SETUP}" >/dev/null
  # shellcheck disable=SC2034  # read by print_manual_start_commands
  COMPOSE_FILES=("${TMP_DIR}/docker-compose.yml")
  # shellcheck disable=SC2034
  ENV_FILE="${TMP_DIR}/.env"
  # Capture first: `| grep -q` would SIGPIPE the printer under pipefail.
  next_steps="$(print_manual_start_commands)"
  grep -q -- "--upgrade" <<< "${next_steps}" \
    || fail "print_manual_start_commands must point at --upgrade, not only 'docker compose pull'"
)
echo "  OK  installer next-steps output names the --upgrade path"

printf 'guided setup upgrade guard passed\n'
