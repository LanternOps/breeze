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
# Release signatures only cover the server container images from the floor on,
# so a release below it can only be installed from unverified image tags. The
# installer refuses that unless the operator passes --allow-unverified-release.
#
# This guard proves, without Docker or network access:
#   1. release_has_signed_image_inventory is false strictly below the floor,
#      true at the floor itself (including a pre-release/build suffix on the
#      floor version), and true above it;
#   2. prepare_templates does NOT require or attempt to download the verifier
#      template when the selected version is below the floor (reachable only
#      with --allow-unverified-release);
#   3. prepare_templates DOES require the verifier template when the selected
#      version is at or above the floor (unchanged fail-closed behavior);
#   4. a release below the floor, or a version that is not an exact release,
#      is refused before any template is touched — whether it was preselected,
#      looked up as the latest release, read back from an existing .env, or
#      typed at the prompt — unless --allow-unverified-release is given, and a
#      release at or above the floor is unaffected;
#   5. the image-ref step refuses a below-floor release on its own (defense in
#      depth), and with the override warns and leaves the tag refs alone.

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

# --- 4. below-floor and non-release versions are refused by default ---------
# Runs guided-setup.sh's real main() in library mode with only the Docker
# preflight and the network lookups stubbed. The work dir holds no templates
# and --no-download is set, so a version that PASSES the gate stops at
# "Missing .../docker-compose.yml" in prepare_templates; a refused one never
# gets that far. Prints combined output; returns the subshell's status.
# $1: work dir name, $2: what the latest-release lookup returns ("" = lookup
# fails), $3: BREEZE_SETUP_VERSION ("" = unset); remaining args go to the CLI.
run_main() {
  # Not "latest": select_breeze_version has its own `local latest`, which
  # would shadow it inside the stub below (bash scoping is dynamic).
  local name="$1" stub_latest_release="$2" preset="$3" work_dir
  shift 3
  work_dir="${TMP_DIR}/main-${name}"
  mkdir -p "${work_dir}"
  (
    set -- --work-dir "${work_dir}" --no-download --no-up "$@"
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    if [[ -n "${preset}" ]]; then
      export BREEZE_SETUP_VERSION="${preset}"
    else
      unset BREEZE_SETUP_VERSION
    fi
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/scripts/guided-setup.sh"
    # Stubs for the Docker preflight and the GitHub/GHCR lookups; main() and
    # select_breeze_version call them indirectly.
    # shellcheck disable=SC2317,SC2329
    check_prerequisites() { :; }
    # shellcheck disable=SC2317,SC2329
    confirm_breeze_version_available() { return 0; }
    # shellcheck disable=SC2317,SC2329
    fetch_latest_github_release_version() {
      [[ -n "${stub_latest_release}" ]] || return 1
      printf '%s' "${stub_latest_release}"
    }
    main
  ) 2>&1
}

REFUSAL='release signatures'
OVERRIDE_FLAG='--allow-unverified-release'
REACHED_TEMPLATES='Missing .*docker-compose.yml'

# Asserts the run was refused at the version gate: non-zero, names why and the
# override, and never reached the template step.
expect_gate_refused() {
  local label="$1" status="$2" output="$3" pattern="${4:-${REFUSAL}}"
  [[ "${status}" -ne 0 ]] || fail "${label}: expected a refusal; it succeeded:\n${output}"
  grep -Eqi -- "${pattern}" <<< "${output}" \
    || fail "${label}: refusal must say why (/${pattern}/); got:\n${output}"
  grep -q -- "${OVERRIDE_FLAG}" <<< "${output}" \
    || fail "${label}: refusal must name ${OVERRIDE_FLAG}; got:\n${output}"
  if grep -Eq -- "${REACHED_TEMPLATES}" <<< "${output}"; then
    fail "${label}: refused too late — it reached the template step first:\n${output}"
  fi
}

# Asserts the run got past the version gate to the template step.
expect_gate_passed() {
  local label="$1" output="$2"
  grep -Eq -- "${REACHED_TEMPLATES}" <<< "${output}" \
    || fail "${label}: expected to pass the version gate and reach the template step; got:\n${output}"
}

BELOW="0.111.0"

# 4a. Preselected (BREEZE_SETUP_VERSION) below the floor.
status=0; output="$(run_main preset-below "" "${BELOW}" -y)" || status=$?
expect_gate_refused "preselected ${BELOW}" "${status}" "${output}"
status=0; output="$(run_main preset-below-v "" "v${BELOW}" -y)" || status=$?
expect_gate_refused "preselected v${BELOW}" "${status}" "${output}"
output="$(run_main preset-below-allowed "" "${BELOW}" -y "${OVERRIDE_FLAG}")" || true
expect_gate_passed "preselected ${BELOW} with ${OVERRIDE_FLAG}" "${output}"
output="$(run_main preset-floor "" "${AT_FLOOR}" -y)" || true
expect_gate_passed "preselected ${AT_FLOOR}" "${output}"
output="$(run_main preset-above "" "9999.0.0" -y)" || true
expect_gate_passed "preselected 9999.0.0" "${output}"
echo "  OK  a preselected release below ${AT_FLOOR} is refused unless ${OVERRIDE_FLAG}; ${AT_FLOOR}+ is unaffected"

# 4b. Not an exact release version: nothing to match to a signed inventory.
status=0; output="$(run_main preset-latest "" "latest" -y)" || status=$?
expect_gate_refused "preselected 'latest'" "${status}" "${output}" "not an exact release version"
# Numerically past the floor but not an exact release: still no inventory to
# match, so refused up front rather than failing later on a missing tag.
status=0; output="$(run_main preset-inexact "" "0.118" -y)" || status=$?
expect_gate_refused "preselected '0.118'" "${status}" "${output}" "not an exact release version"
output="$(run_main preset-inexact-allowed "" "0.118" -y "${OVERRIDE_FLAG}")" || true
expect_gate_passed "preselected '0.118' with ${OVERRIDE_FLAG}" "${output}"
output="$(run_main preset-latest-allowed "" "latest" -y "${OVERRIDE_FLAG}")" || true
expect_gate_passed "preselected 'latest' with ${OVERRIDE_FLAG}" "${output}"
echo "  OK  a version that is not an exact release is refused unless ${OVERRIDE_FLAG}"

# 4c. Unattended (-y) run whose latest-release lookup answers below the floor.
status=0; output="$(run_main latest-below "${BELOW}" "" -y)" || status=$?
expect_gate_refused "latest release lookup ${BELOW}" "${status}" "${output}"
output="$(run_main latest-floor "${AT_FLOOR}" "" -y)" || true
expect_gate_passed "latest release lookup ${AT_FLOOR}" "${output}"
echo "  OK  an unattended run refuses a below-floor latest-release answer"

# 4d. Re-run over an existing below-floor install while GitHub is unreachable:
#     the version detected from .env is the default, and it is refused too.
detected_dir="${TMP_DIR}/main-detected"
mkdir -p "${detected_dir}"
printf 'BREEZE_VERSION=0.105.1\n' > "${detected_dir}/.env"
status=0; output="$(run_main detected "" "" -y)" || status=$?
expect_gate_refused "BREEZE_VERSION detected from .env (0.105.1)" "${status}" "${output}"
echo "  OK  a below-floor BREEZE_VERSION detected from an existing .env is refused"

# 4e. Interactive: a below-floor answer is refused and the prompt repeats.
status=0
output="$(printf '%s\n%s\n' "${BELOW}" "${AT_FLOOR}" | run_main interactive "" "")" || status=$?
grep -Eqi -- "${REFUSAL}" <<< "${output}" \
  || fail "interactive ${BELOW}: expected the refusal warning; got:\n${output}"
grep -q "Selected Breeze version: ${AT_FLOOR}" <<< "${output}" \
  || fail "interactive: expected the prompt to repeat and accept ${AT_FLOOR}; got:\n${output}"
if grep -q "Selected Breeze version: ${BELOW}" <<< "${output}"; then
  fail "interactive: ${BELOW} must not be selected without ${OVERRIDE_FLAG}:\n${output}"
fi
output="$(printf '%s\n' "${BELOW}" | run_main interactive-allowed "" "" "${OVERRIDE_FLAG}")" || true
grep -q "Selected Breeze version: ${BELOW}" <<< "${output}" \
  || fail "interactive ${BELOW} with ${OVERRIDE_FLAG}: expected it to be selected; got:\n${output}"
# A refused default (here an old BREEZE_VERSION read from .env while the
# lookup fails) is dropped: the second bare Enter meets an empty default
# ("BREEZE_VERSION is required."), not the same refusal again.
refused_default_dir="${TMP_DIR}/main-interactive-refused-default"
mkdir -p "${refused_default_dir}"
printf 'BREEZE_VERSION=0.105.1\n' > "${refused_default_dir}/.env"
output="$(printf '\n\n%s\n' "${AT_FLOOR}" | run_main interactive-refused-default "" "")" || true
refusals="$(grep -c "Breeze 0.105.1 is older than" <<< "${output}" || true)"
[[ "${refusals}" -eq 1 ]] \
  || fail "interactive: a refused default must not be offered again (refused ${refusals} times); got:\n${output}"
grep -q "BREEZE_VERSION is required" <<< "${output}" \
  || fail "interactive: expected an empty default after the refusal; got:\n${output}"
grep -q "Selected Breeze version: ${AT_FLOOR}" <<< "${output}" \
  || fail "interactive: expected ${AT_FLOOR} to be selected after the refused default; got:\n${output}"
echo "  OK  the interactive prompt refuses a below-floor answer unless ${OVERRIDE_FLAG}, and drops a refused default"

# --- 5. the image-ref step refuses on its own (defense in depth) ------------
run_image_refs() {
  local version="$1"
  shift
  (
    set -- --work-dir "${TMP_DIR}/image-refs" --no-download --no-up -y "$@"
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/scripts/guided-setup.sh"
    # shellcheck disable=SC2317,SC2329  # invoked indirectly by configure_release_image_refs
    configure_signed_release_image_refs() { echo "SIGNED-REFS-RESOLVED"; }
    # shellcheck disable=SC2034  # read by configure_release_image_refs
    SELECTED_BREEZE_VERSION="${version}"
    configure_release_image_refs
  ) 2>&1
}

status=0; output="$(run_image_refs "${BELOW}")" || status=$?
[[ "${status}" -ne 0 ]] && grep -Eqi -- "${REFUSAL}" <<< "${output}" \
  || fail "configure_release_image_refs must refuse ${BELOW} without ${OVERRIDE_FLAG}; got status ${status}:\n${output}"
status=0; output="$(run_image_refs "${BELOW}" "${OVERRIDE_FLAG}")" || status=$?
[[ "${status}" -eq 0 ]] || fail "configure_release_image_refs must allow ${BELOW} with ${OVERRIDE_FLAG}; got status ${status}:\n${output}"
grep -q -- "${OVERRIDE_FLAG}" <<< "${output}" \
  || fail "configure_release_image_refs must warn loudly (naming ${OVERRIDE_FLAG}) when it proceeds; got:\n${output}"
if grep -q "SIGNED-REFS-RESOLVED" <<< "${output}"; then
  fail "configure_release_image_refs must not try to resolve signed refs below the floor:\n${output}"
fi
status=0; output="$(run_image_refs "${AT_FLOOR}")" || status=$?
[[ "${status}" -eq 0 ]] && grep -q "SIGNED-REFS-RESOLVED" <<< "${output}" \
  || fail "configure_release_image_refs must resolve signed refs at the floor; got status ${status}:\n${output}"
# An inexact version numerically past the floor has no inventory either: with
# the override it takes the same unverified path as an old release.
status=0; output="$(run_image_refs "0.118")" || status=$?
[[ "${status}" -ne 0 ]] && grep -q "not an exact release version" <<< "${output}" \
  || fail "configure_release_image_refs must refuse '0.118' without ${OVERRIDE_FLAG}; got status ${status}:\n${output}"
status=0; output="$(run_image_refs "0.118" "${OVERRIDE_FLAG}")" || status=$?
[[ "${status}" -eq 0 ]] || fail "configure_release_image_refs must allow '0.118' with ${OVERRIDE_FLAG}; got status ${status}:\n${output}"
if grep -q "SIGNED-REFS-RESOLVED" <<< "${output}"; then
  fail "configure_release_image_refs must not try to resolve signed refs for an inexact version:\n${output}"
fi
run_prepare_templates "0.118" "false" \
  || fail "prepare_templates must not require the verifier template for an inexact version (reachable only with ${OVERRIDE_FLAG})"
echo "  OK  the image-ref step refuses below the floor on its own, warns with the override, and verifies at ${AT_FLOOR}+"

printf 'guided setup signed image inventory floor guard passed\n'
