#!/usr/bin/env bash

# Regression guard (#5568): guided setup must generate APP_ENCRYPTION_KEY_ID
# alongside APP_ENCRYPTION_KEY so secrets are sealed as AAD-bound enc:v3
# envelopes on self-hosted installs, and must never change an existing id
# (changing it would orphan every envelope tagged with the old one).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

FUNCTIONS_FILE="${TMP_DIR}/guided-setup-functions.sh"
RESULT_FILE="${TMP_DIR}/result.txt"
sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"

(
  export BREEZE_SETUP_DIR="${TMP_DIR}"
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}" >/dev/null 2>&1
  ENV_FILE="${TMP_DIR}/.env"
  trap - EXIT
  set +e +u +o pipefail
  warn() { :; }
  log() { :; }
  fail() { printf 'fail:%s\n' "$*" >&2; return 1; }

  fails=0
  expect() { # label actual expected
    if [[ "$2" != "$3" ]]; then
      printf 'FAIL %s: got=[%s] want=[%s]\n' "$1" "$2" "$3"
      fails=$((fails + 1))
    fi
  }

  if ! declare -F ensure_app_encryption_key_id >/dev/null; then
    printf 'FAIL ensure_app_encryption_key_id is not defined\n'
    printf 'FAILS=1\n'
    exit 0
  fi

  # Fresh install: blank id -> generated, matches the API's KEY_ID_PATTERN.
  printf 'APP_ENCRYPTION_KEY_ID=\nOTHER=1\n' > "${ENV_FILE}"
  ensure_app_encryption_key_id >/dev/null 2>&1
  got="$(get_env_value APP_ENCRYPTION_KEY_ID)"
  [[ "${got}" =~ ^key-[0-9]{8}$ ]] || { printf 'FAIL generated id [%s] not key-YYYYMMDD\n' "${got}"; fails=$((fails + 1)); }
  expect other-key-untouched "$(get_env_value OTHER)" "1"

  # Missing line entirely -> generated.
  printf 'OTHER=1\n' > "${ENV_FILE}"
  ensure_app_encryption_key_id >/dev/null 2>&1
  got="$(get_env_value APP_ENCRYPTION_KEY_ID)"
  [[ "${got}" =~ ^key-[0-9]{8}$ ]] || { printf 'FAIL absent-line id [%s]\n' "${got}"; fails=$((fails + 1)); }

  # Existing id (hand-set) is preserved verbatim.
  printf 'APP_ENCRYPTION_KEY_ID=prod-1\n' > "${ENV_FILE}"
  ensure_app_encryption_key_id >/dev/null 2>&1
  expect existing-preserved "$(get_env_value APP_ENCRYPTION_KEY_ID)" "prod-1"

  # Idempotent on re-run: second call keeps the first generated value, one line.
  printf 'OTHER=1\n' > "${ENV_FILE}"
  ensure_app_encryption_key_id >/dev/null 2>&1
  first="$(get_env_value APP_ENCRYPTION_KEY_ID)"
  ensure_app_encryption_key_id >/dev/null 2>&1
  expect idempotent "$(get_env_value APP_ENCRYPTION_KEY_ID)" "${first}"
  expect single-line "$(grep -c '^APP_ENCRYPTION_KEY_ID=' "${ENV_FILE}")" "1"

  printf 'FAILS=%s\n' "${fails}"
) > "${RESULT_FILE}" 2>&1

# The installer must actually call it from the secrets step.
if ! grep -qE '^  ensure_app_encryption_key_id( |$)' "${REPO_ROOT}/scripts/guided-setup.sh"; then
  echo 'FAIL guided-setup.sh never calls ensure_app_encryption_key_id' >> "${RESULT_FILE}"
  echo 'FAILS=call-site' >> "${RESULT_FILE}"
fi

if ! grep -q '^FAILS=0$' "${RESULT_FILE}" || grep -q '^FAILS=call-site$' "${RESULT_FILE}"; then
  printf 'check-guided-setup-key-id FAILED:\n' >&2
  cat "${RESULT_FILE}" >&2
  exit 1
fi

printf 'guided setup APP_ENCRYPTION_KEY_ID guard passed\n'
