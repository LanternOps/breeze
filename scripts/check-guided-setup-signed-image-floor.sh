#!/usr/bin/env bash

# Behavioral guard for SIGNED_IMAGE_INVENTORY_MIN_VERSION in
# scripts/guided-setup.sh.
#
# Why this guard exists
# ----------------------
# guided-setup.sh downloads its templates pinned to the SELECTED release tag
# (resolve_template_remote_base -> raw.githubusercontent.com/<repo>/<tag>/...),
# and no published release before SIGNED_IMAGE_INVENTORY_MIN_VERSION ships
# scripts/release/verify-release-images.sh or publishes a signed
# release-artifact-manifest.json. Requiring the verifier template and calling
# configure_signed_release_image_refs unconditionally (regardless of the
# selected version) broke guided setup for EVERY published release below the
# floor with "Missing .../scripts/release/verify-release-images.sh" — a fresh
# self-host install of any existing release died in prepare_templates before
# ever reaching Docker.
#
# This guard proves, without Docker or network access:
#   1. release_has_signed_image_inventory is false strictly below the floor,
#      true at the floor itself (including a pre-release/build suffix on the
#      floor version), and true above it;
#   2. prepare_templates does NOT require or attempt to download the verifier
#      template when the selected version is below the floor;
#   3. prepare_templates DOES require the verifier template when the selected
#      version is at or above the floor (unchanged fail-closed behavior).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

AT_FLOOR="$(
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/scripts/guided-setup.sh"
  printf '%s' "${SIGNED_IMAGE_INVENTORY_MIN_VERSION}"
)"
[[ -n "${AT_FLOOR}" ]] || fail "SIGNED_IMAGE_INVENTORY_MIN_VERSION is not set"

# --- 1. release_has_signed_image_inventory around the floor -----------------
(
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/scripts/guided-setup.sh"

  below="0.111.999"
  above="9999.0.0"
  prerelease_at_floor="${AT_FLOOR}-rc.1"

  if release_has_signed_image_inventory "${below}"; then
    fail "expected ${below} (below the floor) to be treated as unsigned"
  fi
  release_has_signed_image_inventory "${AT_FLOOR}" \
    || fail "expected the floor version ${AT_FLOOR} itself to be treated as signed"
  release_has_signed_image_inventory "${above}" \
    || fail "expected ${above} (above the floor) to be treated as signed"
  release_has_signed_image_inventory "${prerelease_at_floor}" \
    || fail "expected a pre-release tag at the floor's numeric core (${prerelease_at_floor}) to be treated as signed"
)
echo "  OK  release_has_signed_image_inventory is false below the floor, true at/above it"

# --- 2 & 3. prepare_templates requires the verifier only at/above the floor --
run_prepare_templates() {
  local version="$1" seed_verifier="$2" work_dir
  work_dir="${TMP_DIR}/${version//[.\/]/_}-${seed_verifier}"
  mkdir -p "${work_dir}"
  cp "${REPO_ROOT}/docker-compose.yml" "${REPO_ROOT}/.env.example" "${work_dir}/"
  if [[ "${seed_verifier}" == "true" ]]; then
    mkdir -p "${work_dir}/scripts/release"
    cp "${REPO_ROOT}/scripts/release/verify-release-images.sh" "${work_dir}/scripts/release/"
  fi
  (
    set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/scripts/guided-setup.sh"
    # shellcheck disable=SC2034  # read by prepare_templates via release_has_signed_image_inventory
    SELECTED_BREEZE_VERSION="${version}"
    prepare_templates
  ) >/dev/null 2>&1
}

BELOW_FLOOR="0.111.1"

run_prepare_templates "${BELOW_FLOOR}" "false" \
  || fail "prepare_templates failed for below-floor version ${BELOW_FLOOR} without the verifier template present; it should not be required below the floor."
echo "  OK  prepare_templates does not require the verifier template below the floor (${BELOW_FLOOR})"

if run_prepare_templates "${AT_FLOOR}" "false"; then
  fail "prepare_templates succeeded for at-floor version ${AT_FLOOR} without the verifier template present; it must fail closed at/above the floor."
fi
echo "  OK  prepare_templates still requires the verifier template at the floor (${AT_FLOOR}) when it is missing"

run_prepare_templates "${AT_FLOOR}" "true" \
  || fail "prepare_templates failed for at-floor version ${AT_FLOOR} even with the verifier template present."
echo "  OK  prepare_templates succeeds at the floor (${AT_FLOOR}) once the verifier template is present"

printf 'guided setup signed image inventory floor guard passed\n'
