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
  # Belt-and-suspenders with the sed strip above: guided-setup.sh only skips its
  # own `main "$@"` call when this is set, so sourcing here never runs the real
  # installer even if the sed pattern stops matching main's call site.
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}"
  preserve_existing_compose_project_name
)

# Postgres data slots (#11418). docker-compose.yml keeps the database in
# postgres_data or, when POSTGRES_DATA_VOLUME selects it, postgres_data_alt
# (the PostgreSQL major-version runbook restores into the other slot). Project
# name preservation and existing-storage detection must see either slot, so a
# fresh .env never misses a database that lives in the alternate one.
# `docker volume inspect` is stubbed: EXISTING_VOLUMES lists what "exists".
slot_case() {
  local dir_name="$1" existing="$2" check="$3" expected="$4"
  local work_dir="${TMP_DIR}/slots/${dir_name}"
  rm -rf "${work_dir}"
  mkdir -p "${work_dir}"
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env"
  (
    set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    # shellcheck source=/dev/null
    source "${FUNCTIONS_FILE}"
    EXISTING_VOLUMES=" ${existing} "
    docker() {
      if [[ "${1:-} ${2:-}" == "volume inspect" ]]; then
        [[ "${EXISTING_VOLUMES}" == *" ${3:-} "* ]]
        return
      fi
      return 1
    }
    case "${check}" in
      preserve)
        # shellcheck disable=SC2034 # read by the sourced guided-setup functions
        ENV_FILE_CREATED="true"
        preserve_existing_compose_project_name >/dev/null 2>&1
        actual="$(get_env_value COMPOSE_PROJECT_NAME)"
        ;;
      detect)
        # shellcheck disable=SC2034 # read by the sourced guided-setup functions
        STORAGE_MODE="docker"
        actual="$(detect_existing_postgres_storage || printf '<none>')"
        ;;
    esac
    if [[ "${actual}" != "${expected}" ]]; then
      printf 'slot case %s/%s [%s]: expected %q, got %q\n' "${dir_name}" "${check}" "${existing}" "${expected}" "${actual}" >&2
      exit 1
    fi
  )
}

slot_case acme-rmm "acme-rmm_postgres_data" preserve acme-rmm
slot_case acme-rmm "acme-rmm_postgres_data_alt" preserve acme-rmm
slot_case acme-rmm "" preserve breeze
slot_case breeze "breeze_postgres_data" detect "breeze_postgres_data"
slot_case breeze "breeze_postgres_data_alt" detect "breeze_postgres_data_alt"
slot_case breeze "breeze_postgres_data breeze_postgres_data_alt" detect "breeze_postgres_data breeze_postgres_data_alt"
slot_case breeze "other_postgres_data" detect "<none>"

# Re-materializing .env from .env.example (every guided-setup run) keeps the
# selector: losing it after the runbook's cleanup would start Postgres on an
# empty postgres_data.
(
  work_dir="${TMP_DIR}/slots/materialize"
  rm -rf "${work_dir}"
  mkdir -p "${work_dir}"
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env.example"
  cp "${REPO_ROOT}/.env.example" "${work_dir}/.env"
  printf 'POSTGRES_DATA_VOLUME=postgres_data_alt\n' >> "${work_dir}/.env"
  set -- --work-dir "${work_dir}" --env-file "${work_dir}/.env" --no-download --no-up -y
  export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}"
  materialize_env_from_example >/dev/null
  actual="$(get_env_value POSTGRES_DATA_VOLUME)"
  if [[ "${actual}" != "postgres_data_alt" ]]; then
    printf 'materialize_env_from_example dropped POSTGRES_DATA_VOLUME (got %q)\n' "${actual}" >&2
    exit 1
  fi
)

printf 'guided setup default project name guard passed\n'
