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
sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"

run_rewrite_case() {
  local case_name="$1"
  shift
  local actions=("$@")
  local work_dir="${TMP_DIR}/${case_name}"
  local action

  mkdir -p "${work_dir}"
  cp "${REPO_ROOT}/docker-compose.yml" "${work_dir}/docker-compose.yml"
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env.example"

  (
    set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
    # shellcheck source=/dev/null
    source "${FUNCTIONS_FILE}"

    for action in "${actions[@]}"; do
      "${action}"
    done
  )
}

run_rewrite_case external-proxy write_external_proxy_compose_file
run_rewrite_case local-storage write_local_storage_compose_file
run_rewrite_case external-proxy-local-storage write_external_proxy_compose_file write_local_storage_compose_file

printf 'guided setup Compose rewrite guard passed\n'
