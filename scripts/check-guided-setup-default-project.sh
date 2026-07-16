#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

FUNCTIONS_FILE="${TMP_DIR}/guided-setup-functions.sh"
WORK_DIR="${TMP_DIR}/breeze"

sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"
mkdir -p "${WORK_DIR}"
cp "${REPO_ROOT}/.env.example" "${WORK_DIR}/.env"

(
  set -- --work-dir "${WORK_DIR}" --env-file "${WORK_DIR}/.env" --no-download --no-up -y
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}"
  preserve_existing_compose_project_name
)

printf 'guided setup default project name guard passed\n'
