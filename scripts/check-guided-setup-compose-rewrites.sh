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

# A Compose file from a release before the Postgres data-volume selector
# (#11418): the upgrade guide fetches guided-setup.sh from main while the
# Compose file comes from the installed release, so both mount forms must
# rewrite.
LEGACY_COMPOSE="${TMP_DIR}/legacy-docker-compose.yml"
sed 's|- ${POSTGRES_DATA_VOLUME:-postgres_data}:/var/lib/postgresql/data|- postgres_data:/var/lib/postgresql/data|' \
  "${REPO_ROOT}/docker-compose.yml" > "${LEGACY_COMPOSE}"
if ! grep -Fq -- '- postgres_data:/var/lib/postgresql/data' "${LEGACY_COMPOSE}"; then
  printf 'legacy Compose fixture did not get the literal postgres_data mount\n' >&2
  exit 1
fi

run_rewrite_case() {
  local case_name="$1"
  shift
  local source_compose="${REPO_ROOT}/docker-compose.yml"
  if [[ "${case_name}" == legacy-* ]]; then
    source_compose="${LEGACY_COMPOSE}"
  fi
  local actions=("$@")
  local work_dir="${TMP_DIR}/${case_name}"
  local action

  mkdir -p "${work_dir}"
  cp "${source_compose}" "${work_dir}/docker-compose.yml"
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env.example"

  (
    set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
    # Belt-and-suspenders with the sed strip above: guided-setup.sh only skips
    # its own `main "$@"` call when this is set, so sourcing here never runs
    # the real installer even if the sed pattern stops matching main's call site.
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
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
run_rewrite_case legacy-local-storage write_local_storage_compose_file
run_rewrite_case legacy-external-proxy-local-storage write_external_proxy_compose_file write_local_storage_compose_file

# Local storage bind-mounts ./data/postgres for the database; neither named
# Postgres slot, nor the selector, may survive the rewrite.
for case_name in local-storage external-proxy-local-storage legacy-local-storage legacy-external-proxy-local-storage; do
  generated="${TMP_DIR}/${case_name}/docker-compose.yml"
  if grep -Ev '^[[:space:]]*#' "${generated}" | grep -Eq 'POSTGRES_DATA_VOLUME|postgres_data(_alt)?:'; then
    printf '%s: a named Postgres slot or the selector survived the local-storage rewrite\n' "${case_name}" >&2
    exit 1
  fi
done

printf 'guided setup Compose rewrite guard passed\n'
