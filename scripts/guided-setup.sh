#!/usr/bin/env bash

set -euo pipefail
umask 077

REMOTE_BASE_OVERRIDE="${BREEZE_SETUP_REMOTE_BASE:-}"
REMOTE_BASE="${REMOTE_BASE_OVERRIDE}"
WORK_DIR="${BREEZE_SETUP_DIR:-$(pwd)}"
ENV_FILE=""
ENV_FILE_CREATED="false"
YES_MODE="false"
NO_UP="false"
DRY_RUN="${BREEZE_SETUP_DRY_RUN:-false}"
INSTALL_SYSTEMD_ONLY="false"
DOWNLOAD_MODE="ask"
SECRET_MODE="${BREEZE_SETUP_SECRET_MODE:-}"
STORAGE_MODE="${BREEZE_SETUP_STORAGE_MODE:-}"
INSTALL_SYSTEMD="${BREEZE_SETUP_INSTALL_SYSTEMD:-}"
SYSTEMD_SERVICE_NAME="${BREEZE_SETUP_SYSTEMD_SERVICE_NAME:-breeze-rmm}"
SYSTEMD_HELPER_FILE="${BREEZE_SETUP_SYSTEMD_HELPER_FILE:-/usr/local/lib/${SYSTEMD_SERVICE_NAME}/breeze-compose-boot.sh}"

MIN_CPU_CORES="${BREEZE_SETUP_MIN_CPU_CORES:-2}"
MIN_RAM_MB="${BREEZE_SETUP_MIN_RAM_MB:-4096}"
RECOMMENDED_RAM_MB="${BREEZE_SETUP_RECOMMENDED_RAM_MB:-8192}"
MIN_DISK_GB="${BREEZE_SETUP_MIN_DISK_GB:-20}"

BOOTSTRAP_EMAIL=""
BOOTSTRAP_PASSWORD=""
BOOTSTRAP_NAME=""
BOOTSTRAP_SCRUBBED="false"
STACK_STARTED="false"
REVERSE_PROXY_MODE="caddy"
REVERSE_PROXY_LABEL="Packaged Caddy"
REVERSE_PROXY_EXTERNAL_CIDRS=""
STORAGE_MODE_LABEL="Docker named volumes"
PROXY_BIND_HOST="${BREEZE_SETUP_PROXY_BIND_HOST:-127.0.0.1}"
PROXY_TARGET_HOST="${BREEZE_SETUP_PROXY_TARGET_HOST:-}"
API_HOST_PORT="${BREEZE_SETUP_API_HOST_PORT:-3001}"
WEB_HOST_PORT="${BREEZE_SETUP_WEB_HOST_PORT:-4321}"
SELECTED_BREEZE_VERSION=""
BACK_STATUS=42
BOOTSTRAP_ENV_KEYS=(
  BREEZE_BOOTSTRAP_ADMIN_EMAIL
  BREEZE_BOOTSTRAP_ADMIN_PASSWORD
  BREEZE_BOOTSTRAP_ADMIN_NAME
)

if [[ -t 1 ]]; then
  C_OK=$'\033[32m'
  C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_OK=""
  C_WARN=""
  C_ERR=""
  C_BOLD=""
  C_DIM=""
  C_RESET=""
fi

usage() {
  cat <<'EOF'
Guided Breeze self-host setup.

Usage:
  bash scripts/guided-setup.sh [options]

Options:
  --work-dir DIR       Directory that should contain docker-compose.yml and .env.
                       Defaults to the current directory.
  --env-file FILE      Environment file to create/update. Defaults to WORK_DIR/.env.
  --download           Download docker-compose.yml and .env.example without prompting.
  --no-download        Do not download templates; fail if they are missing.
  --no-up              Generate/validate .env but do not pull images or start Compose.
  --dry-run            Exercise the full guided flow without Docker or systemd changes.
  --install-systemd    Install/update the Linux systemd boot service, then exit.
  -y, --yes            Accept safe defaults and non-destructive prompts.
  -h, --help           Show this help.

Environment overrides:
  BREEZE_SETUP_REMOTE_BASE   Override raw GitHub base URL for template testing.
  BREEZE_SETUP_GITHUB_REPO   GitHub repo for latest release lookup.
  BREEZE_SETUP_SECRET_MODE   Secret workflow: auto or manual.
  BREEZE_SETUP_STORAGE_MODE  Storage mode: docker or local.
  BREEZE_SETUP_DRY_RUN       Exercise prompts without Docker/systemd changes: true or false.
  BREEZE_SETUP_INSTALL_SYSTEMD Install Linux systemd boot service: true or false.
  BREEZE_SETUP_SYSTEMD_HELPER_FILE Root-owned helper path for the systemd unit.
  BREEZE_SETUP_MIN_CPU_CORES Minimum CPU cores before a warning.
  BREEZE_SETUP_MIN_RAM_MB    Minimum RAM before a warning.
  BREEZE_SETUP_MIN_DISK_GB   Minimum free disk before a warning.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --work-dir)
      WORK_DIR="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --download)
      DOWNLOAD_MODE="always"
      shift
      ;;
    --no-download)
      DOWNLOAD_MODE="never"
      shift
      ;;
    --no-up)
      NO_UP="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --install-systemd)
      INSTALL_SYSTEMD_ONLY="true"
      shift
      ;;
    -y|--yes)
      YES_MODE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${DRY_RUN}" in
  true|TRUE|yes|YES|1)
    DRY_RUN="true"
    ;;
  false|FALSE|no|NO|0|"")
    DRY_RUN="false"
    ;;
  *)
    echo "BREEZE_SETUP_DRY_RUN must be true or false." >&2
    exit 2
    ;;
esac

if [[ -z "${WORK_DIR}" ]]; then
  echo "Working directory cannot be empty." >&2
  exit 1
fi
mkdir -p "${WORK_DIR}"
WORK_DIR="$(cd "${WORK_DIR}" && pwd)"

if [[ -z "${ENV_FILE}" ]]; then
  ENV_FILE="${WORK_DIR}/.env"
fi

COMPOSE_FILE="${WORK_DIR}/docker-compose.yml"
ENV_EXAMPLE_FILE="${WORK_DIR}/.env.example"
CADDYFILE_FILE="${WORK_DIR}/docker/Caddyfile.prod"
COMPOSE_PROXY_OVERRIDE_FILE="${WORK_DIR}/docker-compose.byo-proxy.yml"
PROXY_GUIDE_FILE="${WORK_DIR}/reverse-proxy-setup.md"
COMPOSE_FILES=("${COMPOSE_FILE}")

log() {
  printf '%s\n' "$*"
}

section() {
  printf '\n%s============================================================%s\n' "${C_DIM}" "${C_RESET}"
  printf '%s== %s ==%s\n' "${C_BOLD}" "$1" "${C_RESET}"
  printf '%s============================================================%s\n\n' "${C_DIM}" "${C_RESET}"
}

subsection() {
  printf '\n%s-- %s --%s\n' "${C_BOLD}" "$1" "${C_RESET}"
  printf '%s------------------------------------------------------------%s\n' "${C_DIM}" "${C_RESET}"
}

warn() {
  printf '%s[warn]%s %s\n' "${C_WARN}" "${C_RESET}" "$*" >&2
}

fail() {
  printf '%s[error]%s %s\n' "${C_ERR}" "${C_RESET}" "$*" >&2
  exit 1
}

dry_run_enabled() {
  [[ "${DRY_RUN}" == "true" ]]
}

dry_run_log() {
  log "[dry-run] $*"
}

read_prompt() {
  local __var_name="$1"
  local prompt="$2"

  [[ "${__var_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "Invalid prompt variable name: ${__var_name}"
  if [[ -t 0 ]]; then
    read -r -e -p "${prompt}" "${__var_name?}"
  else
    read -r -p "${prompt}" "${__var_name?}"
  fi
}

read_secret_prompt() {
  local __var_name="$1"
  local prompt="$2"

  [[ "${__var_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "Invalid prompt variable name: ${__var_name}"
  if [[ -t 0 ]]; then
    read -r -s -e -p "${prompt}" "${__var_name?}"
  else
    read -r -s -p "${prompt}" "${__var_name?}"
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default_answer="$2"
  local answer suffix

  if [[ "${YES_MODE}" == "true" ]]; then
    [[ "${default_answer}" == "yes" ]]
    return
  fi

  if [[ "${default_answer}" == "yes" ]]; then
    suffix="[Y/n]"
  else
    suffix="[y/N]"
  fi

  while true; do
    if ! read_prompt answer "${prompt} ${suffix} "; then
      fail "No input received for prompt: ${prompt}"
    fi
    answer="${answer:-${default_answer}}"
    case "${answer}" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No) return 1 ;;
      *) log "Please answer yes or no." ;;
    esac
  done
}

is_back_answer() {
  case "$1" in
    b|B|back|Back|BACK|prev|Prev|previous|Previous|PREVIOUS) return 0 ;;
    *) return 1 ;;
  esac
}

select_secret_mode() {
  local choice

  case "${SECRET_MODE}" in
    auto|manual)
      ;;
    "")
      ;;
    *)
      fail "BREEZE_SETUP_SECRET_MODE must be auto or manual."
      ;;
  esac

  section "Secret Workflow"

  if [[ "${YES_MODE}" == "true" && -z "${SECRET_MODE}" ]]; then
    SECRET_MODE="auto"
  fi

  if [[ -n "${SECRET_MODE}" ]]; then
    subsection "Selected Mode"
    if [[ "${SECRET_MODE}" == "auto" ]]; then
      log "Required passwords and application secrets will be generated automatically when missing or still set to example values."
    else
      log "Required passwords and application secrets will be prompted one by one."
    fi
    return
  fi

  subsection "Secret Handling"
  log "Choose how Breeze should fill required passwords and application secrets."
  log "  1) auto   Generate missing/example passwords and secrets"
  log "  2) manual Prompt for each password and secret"
  while true; do
    if ! read_prompt choice "Secret setup mode [1]: "; then
      fail "No input received for secret workflow."
    fi
    choice="${choice:-1}"
    case "${choice}" in
      1|a|A|auto|generate|generated)
        SECRET_MODE="auto"
        log "Required passwords and application secrets will be generated automatically when missing or still set to example values."
        return
        ;;
      2|m|M|manual|enter)
        SECRET_MODE="manual"
        log "Required passwords and application secrets will be prompted one by one."
        return
        ;;
      *)
        log "Choose auto or manual."
        ;;
    esac
  done
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

detect_cpu_cores() {
  if command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN 2>/dev/null && return
  fi
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu 2>/dev/null && return
  fi
  echo 0
}

detect_ram_mb() {
  if [[ -r /proc/meminfo ]]; then
    awk '/MemTotal:/ { printf "%d\n", $2 / 1024 }' /proc/meminfo
    return
  fi
  if command -v sysctl >/dev/null 2>&1; then
    local bytes
    bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    echo $((bytes / 1024 / 1024))
    return
  fi
  echo 0
}

detect_disk_gb() {
  df -Pk "${WORK_DIR}" | awk 'NR == 2 { printf "%d\n", $4 / 1024 / 1024 }'
}

scan_local_ipv4_addresses() {
  {
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show scope global 2>/dev/null | awk '{ split($4, parts, "/"); print parts[1] }'
    fi

    if command -v ifconfig >/dev/null 2>&1; then
      ifconfig 2>/dev/null | awk '
        $1 == "inet" && $2 !~ /^127\./ && $2 != "0.0.0.0" {
          print $2
        }
      '
    fi

    if command -v hostname >/dev/null 2>&1; then
      hostname -I 2>/dev/null | tr ' ' '\n'
    fi
  } | awk '
    /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $0 !~ /^127\./ && $0 != "0.0.0.0" {
      if (!seen[$0]++) print
    }
  '
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR > 1 { found=1 } END { exit found ? 0 : 1 }'
    return
  fi
  return 1
}

check_prerequisites() {
  section "Preflight"
  if dry_run_enabled; then
    warn "Dry run enabled: setup will not pull images, start containers, recreate containers, delete Docker storage, or install systemd files."
  fi
  subsection "Required Commands"
  require_command docker
  require_command openssl
  require_command curl
  require_command awk
  require_command sed
  require_command df
  log "Required commands found: docker, openssl, curl, awk, sed, df"

  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose v2 plugin is required. Install Docker Engine/Desktop with the compose plugin."
  fi

  if ! docker info >/dev/null 2>&1 && ! dry_run_enabled; then
    fail "Docker is installed but the daemon is not reachable. Start Docker and rerun this script."
  fi

  local cpu_cores ram_mb disk_gb warning_count
  cpu_cores="$(detect_cpu_cores)"
  ram_mb="$(detect_ram_mb)"
  disk_gb="$(detect_disk_gb)"
  warning_count=0

  subsection "Detected Resources"
  log "Docker: $(docker --version)"
  log "Compose: $(docker compose version)"
  if dry_run_enabled; then
    dry_run_log "Skipping Docker daemon reachability requirement."
  fi
  log "CPU cores: ${cpu_cores}"
  log "RAM: ${ram_mb} MB"
  log "Free disk in ${WORK_DIR}: ${disk_gb} GB"

  if (( cpu_cores > 0 && cpu_cores < MIN_CPU_CORES )); then
    warn "Breeze should have at least ${MIN_CPU_CORES} CPU cores."
    warning_count=$((warning_count + 1))
  fi
  if (( ram_mb > 0 && ram_mb < MIN_RAM_MB )); then
    warn "Breeze should have at least ${MIN_RAM_MB} MB RAM; ${RECOMMENDED_RAM_MB} MB is recommended."
    warning_count=$((warning_count + 1))
  elif (( ram_mb > 0 && ram_mb < RECOMMENDED_RAM_MB )); then
    warn "Breeze can run with ${ram_mb} MB RAM, but ${RECOMMENDED_RAM_MB} MB is recommended."
  fi
  if (( disk_gb < MIN_DISK_GB )); then
    warn "Breeze should have at least ${MIN_DISK_GB} GB free disk for images, volumes, logs, and backups."
    warning_count=$((warning_count + 1))
  fi

  if (( warning_count > 0 )); then
    subsection "Preflight Warnings"
    ask_yes_no "Continue despite preflight warnings?" "no" || exit 1
  fi
}

check_proxy_port_conflicts() {
  local port80_in_use="false"
  local port443_in_use="false"
  local api_port_in_use="false"
  local web_port_in_use="false"

  if [[ "${REVERSE_PROXY_MODE}" == "caddy" ]]; then
    if port_in_use 80; then
      port80_in_use="true"
    fi
    if port_in_use 443; then
      port443_in_use="true"
    fi

    if [[ "${port80_in_use}" == "true" || "${port443_in_use}" == "true" ]]; then
      section "Caddy Ports"
      if [[ "${port80_in_use}" == "true" ]]; then
        warn "Port 80 is already in use. Packaged Caddy direct mode may fail to bind."
      fi
      if [[ "${port443_in_use}" == "true" ]]; then
        warn "Port 443 is already in use. Packaged Caddy direct mode may fail to bind."
      fi
    fi
    return
  fi

  if port_in_use "${API_HOST_PORT}"; then
    api_port_in_use="true"
  fi
  if port_in_use "${WEB_HOST_PORT}"; then
    web_port_in_use="true"
  fi

  if [[ "${api_port_in_use}" == "true" || "${web_port_in_use}" == "true" ]]; then
    section "External Proxy Ports"
    if [[ "${api_port_in_use}" == "true" ]]; then
      warn "Port ${API_HOST_PORT} is already in use. Breeze API may fail to bind for your reverse proxy."
    fi
    if [[ "${web_port_in_use}" == "true" ]]; then
      warn "Port ${WEB_HOST_PORT} is already in use. Breeze Web may fail to bind for your reverse proxy."
    fi
  fi
}

backup_path_for() {
  local file="$1"
  local stamp backup suffix
  stamp="$(date +%Y%m%d%H%M%S)"
  backup="${file}.bak.${stamp}"
  suffix=1
  while [[ -e "${backup}" ]]; do
    backup="${file}.bak.${stamp}.${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s' "${backup}"
}

backup_file() {
  local file="$1"
  local backup
  backup="$(backup_path_for "${file}")"
  # cp at the process umask can leave a 0644 copy; when the source is .env this
  # backup carries the same secrets, so create it then tighten to 0600. Both are
  # guarded because callers may run with errexit disabled (see start_stack).
  if ! cp "${file}" "${backup}"; then
    fail "Failed to back up ${file} to ${backup}."
  fi
  if ! chmod 600 "${backup}"; then
    fail "Failed to secure permissions on backup ${backup}; it may contain secrets. Remove it manually."
  fi
  log "Backed up ${file} to ${backup}"
}

download_template() {
  local name="$1"
  local target="${WORK_DIR}/${name}"
  local tmp
  local url

  [[ -n "${REMOTE_BASE}" ]] || fail "Template remote base is not configured."

  if [[ -e "${target}" && ! -f "${target}" ]]; then
    fail "${target} exists but is not a regular file. Remove or rename it before downloading templates."
  fi

  mkdir -p "$(dirname "${target}")"
  tmp="$(mktemp "${target}.tmp.XXXXXX")"

  if [[ -f "${target}" ]]; then
    backup_file "${target}"
  fi

  url="${REMOTE_BASE}/${name}"
  log "Downloading ${name} from ${url}"
  if ! curl -fsSL "${url}" -o "${tmp}"; then
    rm -f "${tmp}"
    fail "Failed to download ${name} from ${url}. Check that the selected Breeze release includes this template."
  fi
  if ! mv "${tmp}" "${target}"; then
    rm -f "${tmp}"
    fail "Failed to install downloaded ${name} at ${target}."
  fi
}

prepare_templates() {
  section "Templates"

  local need_download="false"
  if [[ -n "${REMOTE_BASE}" ]]; then
    log "Template source: ${REMOTE_BASE}"
  fi
  if [[ ! -f "${COMPOSE_FILE}" || ! -f "${ENV_EXAMPLE_FILE}" ]]; then
    need_download="true"
  fi

  case "${DOWNLOAD_MODE}" in
    always)
      subsection "Download Templates"
      download_template "docker-compose.yml"
      download_template ".env.example"
      ;;
    never)
      subsection "Use Existing Templates"
      [[ -f "${COMPOSE_FILE}" ]] || fail "Missing ${COMPOSE_FILE}"
      [[ -f "${ENV_EXAMPLE_FILE}" ]] || fail "Missing ${ENV_EXAMPLE_FILE}"
      log "Using existing docker-compose.yml and .env.example."
      ;;
    ask)
      if [[ "${need_download}" == "true" ]]; then
        subsection "Download Templates"
        download_template "docker-compose.yml"
        download_template ".env.example"
      else
        subsection "Template Source"
        if ask_yes_no "Download fresh docker-compose.yml and .env.example into ${WORK_DIR}?" "no"; then
          download_template "docker-compose.yml"
          download_template ".env.example"
        else
          log "Using existing docker-compose.yml and .env.example."
        fi
      fi
      ;;
  esac
}

prepare_env_file() {
  section "Environment File"
  subsection "Create Or Update .env"

  if [[ -f "${ENV_FILE}" ]]; then
    log "Using existing ${ENV_FILE}."
    if ask_yes_no "Back up ${ENV_FILE} before updating it?" "yes"; then
      backup_file "${ENV_FILE}"
    fi
  else
    cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    ENV_FILE_CREATED="true"
    log "Created ${ENV_FILE} from .env.example."
  fi

  chmod 600 "${ENV_FILE}"
}

sanitize_compose_project_name() {
  local name="$1"
  name="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g; s/^[^a-z0-9]*//')"
  printf '%s' "${name}"
}

preserve_existing_compose_project_name() {
  local configured name volume_name

  name="$(sanitize_compose_project_name "$(basename "${WORK_DIR}")")"
  [[ -n "${name}" && "${name}" != "breeze" ]] || return 0

  volume_name="${name}_postgres_data"
  configured="$(get_env_value "COMPOSE_PROJECT_NAME")"
  if [[ -z "${configured}" || ( "${ENV_FILE_CREATED}" == "true" && "${configured}" == "breeze" ) ]] \
    && docker volume inspect "${volume_name}" >/dev/null 2>&1; then
    set_env_value "COMPOSE_PROJECT_NAME" "${name}"
    warn "Found existing Docker volume ${volume_name}; preserving COMPOSE_PROJECT_NAME=${name} so existing data stays attached."
  fi
}

shell_quote() {
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "${value}"
}

bash_source_quote() {
  printf '%q' "$1"
}

systemd_available() {
  [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  [[ -d /run/systemd/system ]] || return 1
}

run_privileged() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  fail "Root privileges are required. Rerun with sudo or install the systemd unit manually."
}

write_boot_helper() {
  local compose_array file helper_dir helper_tmp

  compose_array=$'compose=(\n  docker\n  compose\n'
  for file in "${COMPOSE_FILES[@]}"; do
    compose_array+=$'  -f\n'
    compose_array+="  $(bash_source_quote "${file}")"$'\n'
  done
  compose_array+=$'  --env-file\n'
  compose_array+="  $(bash_source_quote "${ENV_FILE}")"$'\n'
  compose_array+=')'

  helper_dir="${SYSTEMD_HELPER_FILE%/*}"
  helper_tmp="$(mktemp)"
  cat > "${helper_tmp}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

${compose_array}
up=("\${compose[@]}" up -d --pull never)

wait_for_docker() {
  for _ in \$(seq 1 60); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

service_exists() {
  "\${compose[@]}" config --services | grep -qx "\$1"
}

start_remaining_services() {
  local service services

  if ! services="\$("\${compose[@]}" config --services)"; then
    echo "Failed to read Compose services from docker compose config --services." >&2
    return 1
  fi

  while IFS= read -r service; do
    [[ -n "\${service}" ]] || continue
    case "\${service}" in
      postgres|redis|binaries-init|api|web|caddy) continue ;;
    esac
    "\${up[@]}" "\${service}"
  done <<< "\${services}"
}

case "\${1:-up}" in
  up)
    wait_for_docker
    "\${compose[@]}" config --quiet

    "\${up[@]}" postgres redis
    "\${up[@]}" --force-recreate binaries-init
    "\${up[@]}" --force-recreate api web

    if service_exists caddy; then
      "\${up[@]}" --force-recreate caddy
    fi

    start_remaining_services
    ;;
  down)
    if docker info >/dev/null 2>&1; then
      "\${compose[@]}" down --timeout 60 --remove-orphans
    fi
    ;;
  *)
    echo "Usage: \$0 [up|down]" >&2
    exit 2
    ;;
esac
EOF
  run_privileged install -d -m 0755 "${helper_dir}"
  run_privileged install -m 0755 "${helper_tmp}" "${SYSTEMD_HELPER_FILE}"
  rm -f "${helper_tmp}"
}

install_systemd_boot_service() {
  local unit_file unit_tmp

  if dry_run_enabled; then
    dry_run_log "Would install Compose boot helper at ${SYSTEMD_HELPER_FILE}."
    dry_run_log "Would install systemd unit at /etc/systemd/system/${SYSTEMD_SERVICE_NAME}.service."
    dry_run_log "Would run: systemctl daemon-reload"
    dry_run_log "Would run: systemctl enable --now ${SYSTEMD_SERVICE_NAME}.service"
    return
  fi

  write_boot_helper
  unit_file="/etc/systemd/system/${SYSTEMD_SERVICE_NAME}.service"
  unit_tmp="$(mktemp)"

  cat > "${unit_tmp}" <<EOF
[Unit]
Description=Breeze RMM Docker Compose startup repair
Requires=docker.service
Wants=network-online.target
After=docker.service network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
WorkingDirectory=$(shell_quote "${WORK_DIR}")
ExecStart=$(shell_quote "${SYSTEMD_HELPER_FILE}")
ExecStop=$(shell_quote "${SYSTEMD_HELPER_FILE}") down
RemainAfterExit=yes
TimeoutStartSec=15min
TimeoutStopSec=3min
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

  run_privileged install -m 0644 "${unit_tmp}" "${unit_file}"
  rm -f "${unit_tmp}"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now "${SYSTEMD_SERVICE_NAME}.service"
  log "${C_OK}Installed ${SYSTEMD_HELPER_FILE} and enabled ${SYSTEMD_SERVICE_NAME}.service.${C_RESET}"
}

configure_boot_start() {
  section "Reboot Startup"

  if ! systemd_available; then
    if dry_run_enabled; then
      warn "systemd is not available on this host; dry run will still show the systemd service choice."
    else
      warn "systemd is not available; Breeze will rely on Docker restart policies after host reboots."
      return
    fi
  fi

  log "After a host reboot, Docker may restart individual containers before dependencies are ready."
  log "Setup can install a small systemd service that gives Breeze a cleaner shutdown and startup path:"
  log "  - on shutdown, it asks Docker Compose to stop the Breeze stack before Docker itself stops"
  log "  - on startup, it reruns Docker Compose after Docker and networking are online"
  log "This helps Breeze stop cleanly and then start Postgres/Redis, API/Web, and optional services in the intended order."

  case "${INSTALL_SYSTEMD}" in
    true|TRUE|yes|YES|1)
      install_systemd_boot_service
      return
      ;;
    false|FALSE|no|NO|0)
      log "Skipping systemd boot service because BREEZE_SETUP_INSTALL_SYSTEMD=${INSTALL_SYSTEMD}."
      return
      ;;
    "")
      ;;
    *)
      fail "BREEZE_SETUP_INSTALL_SYSTEMD must be true or false."
      ;;
  esac

  if [[ "${YES_MODE}" == "true" ]]; then
    warn "Skipping systemd boot service in --yes mode. Set BREEZE_SETUP_INSTALL_SYSTEMD=true to install it non-interactively."
    return
  fi

  if ask_yes_no "Install the Breeze reboot startup service now?" "yes"; then
    install_systemd_boot_service
  else
    warn "Skipped systemd boot service. After a host reboot, rerun docker compose up -d from ${WORK_DIR} if API/Web do not recover cleanly."
  fi
}

install_systemd_only() {
  section "Boot Startup"
  require_command docker

  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose v2 plugin is required. Install Docker Engine/Desktop with the compose plugin."
  fi

  [[ -f "${COMPOSE_FILE}" ]] || fail "Missing ${COMPOSE_FILE}"
  [[ -f "${ENV_FILE}" ]] || fail "Missing ${ENV_FILE}"

  validate_compose_config

  if ! systemd_available && ! dry_run_enabled; then
    fail "systemd is not available on this host."
  elif ! systemd_available; then
    warn "systemd is not available on this host; dry run will show what would be installed."
  fi

  install_systemd_boot_service
}

remove_generated_proxy_override_if_present() {
  if [[ ! -f "${COMPOSE_PROXY_OVERRIDE_FILE}" ]]; then
    return
  fi

  if ! grep -q 'Generated by scripts/guided-setup.sh' "${COMPOSE_PROXY_OVERRIDE_FILE}"; then
    warn "Leaving existing ${COMPOSE_PROXY_OVERRIDE_FILE}; it was not generated by this setup script."
    return
  fi

  backup_file "${COMPOSE_PROXY_OVERRIDE_FILE}"
  rm -f "${COMPOSE_PROXY_OVERRIDE_FILE}"
  log "Removed legacy external-proxy Compose override. ${COMPOSE_FILE} is now generated as the runnable Compose file."
}

fail_compose_rewrite() {
  local generated_file="$1"
  shift
  rm -f "${generated_file}"
  fail "$*"
}

assert_generated_compose_contains() {
  local generated_file="$1"
  local expected="$2"
  local description="$3"

  if ! grep -Fq -- "${expected}" "${generated_file}"; then
    fail_compose_rewrite "${generated_file}" "Generated Compose file is missing ${description}; ${COMPOSE_FILE} was left unchanged."
  fi
}

assert_generated_compose_absent_regex() {
  local generated_file="$1"
  local unexpected_regex="$2"
  local description="$3"

  if grep -Eq -- "${unexpected_regex}" "${generated_file}"; then
    fail_compose_rewrite "${generated_file}" "Generated Compose file still contains ${description}; ${COMPOSE_FILE} was left unchanged."
  fi
}

assert_external_proxy_compose_rewrite() {
  local generated_file="$1"

  [[ -s "${generated_file}" ]] || fail_compose_rewrite "${generated_file}" "Generated external-proxy Compose file was empty; ${COMPOSE_FILE} was left unchanged."
  assert_generated_compose_absent_regex "${generated_file}" '^  caddy:[[:space:]]*$' "the packaged Caddy service"
  assert_generated_compose_absent_regex "${generated_file}" '^  caddy_(data|config):[[:space:]]*$' "packaged Caddy volumes"
  # shellcheck disable=SC2016
  assert_generated_compose_contains "${generated_file}" '      - "${BREEZE_PROXY_BIND_HOST:-127.0.0.1}:${BREEZE_API_HOST_PORT:-3001}:3001"' "the API host port mapping"
  # shellcheck disable=SC2016
  assert_generated_compose_contains "${generated_file}" '      - "${BREEZE_PROXY_BIND_HOST:-127.0.0.1}:${BREEZE_WEB_HOST_PORT:-4321}:4321"' "the Web host port mapping"
}

write_external_proxy_compose_file() {
  local tmp

  if grep -q 'Generated by scripts/guided-setup.sh for external reverse proxy mode' "${COMPOSE_FILE}" \
    && ! grep -q '^  caddy:' "${COMPOSE_FILE}"; then
    log "${COMPOSE_FILE} is already configured for an external reverse proxy."
    return
  fi

  if ! grep -q '^  caddy:' "${COMPOSE_FILE}"; then
    fail "${COMPOSE_FILE} does not contain the packaged Caddy service. Restore the original Compose file or rerun with --download before switching proxy modes."
  fi

  tmp="$(mktemp "${COMPOSE_FILE}.tmp.XXXXXX")"
  backup_file "${COMPOSE_FILE}"

  if ! awk '
    NR == 1 {
      print "# Generated by scripts/guided-setup.sh for external reverse proxy mode."
      print "# Packaged Caddy has been removed; API/Web host ports are configured from .env."
      print "# Port env vars: BREEZE_PROXY_BIND_HOST, BREEZE_API_HOST_PORT, BREEZE_WEB_HOST_PORT."
    }

    /^services:[[:space:]]*$/ {
      in_volumes = 0
      print
      next
    }

    /^volumes:[[:space:]]*$/ {
      in_volumes = 1
      print
      next
    }

    in_volumes && /^  caddy_(data|config):[[:space:]]*$/ {
      next
    }

    /^  caddy:[[:space:]]*$/ {
      skip_caddy = 1
      next
    }

    skip_caddy && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      skip_caddy = 0
      service = $1
      sub(/:$/, "", service)
      print
      next
    }

    skip_caddy {
      next
    }

    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      service = $1
      sub(/:$/, "", service)
      print
      next
    }

    service == "api" && /^    restart: unless-stopped[[:space:]]*$/ {
      print
      print "    ports:"
      print "      - \"${BREEZE_PROXY_BIND_HOST:-127.0.0.1}:${BREEZE_API_HOST_PORT:-3001}:3001\""
      next
    }

    service == "web" && /^    restart: unless-stopped[[:space:]]*$/ {
      print
      print "    ports:"
      print "      - \"${BREEZE_PROXY_BIND_HOST:-127.0.0.1}:${BREEZE_WEB_HOST_PORT:-4321}:4321\""
      next
    }

    {
      print
    }
  ' "${COMPOSE_FILE}" > "${tmp}"; then
    rm -f "${tmp}"
    fail "Failed to generate external-proxy Compose file; ${COMPOSE_FILE} was left unchanged."
  fi

  assert_external_proxy_compose_rewrite "${tmp}"
  if ! mv "${tmp}" "${COMPOSE_FILE}"; then
    rm -f "${tmp}"
    fail "Failed to replace ${COMPOSE_FILE} with generated external-proxy Compose file."
  fi
}

ensure_local_storage_dirs() {
  mkdir -p \
    "${WORK_DIR}/data/binaries" \
    "${WORK_DIR}/data/api" \
    "${WORK_DIR}/data/postgres" \
    "${WORK_DIR}/data/redis"

  if grep -q '^  caddy:' "${COMPOSE_FILE}"; then
    mkdir -p \
      "${WORK_DIR}/data/caddy/data" \
      "${WORK_DIR}/data/caddy/config"
  fi
}

assert_local_storage_compose_rewrite() {
  local generated_file="$1"

  [[ -s "${generated_file}" ]] || fail_compose_rewrite "${generated_file}" "Generated local-storage Compose file was empty; ${COMPOSE_FILE} was left unchanged."

  assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- binaries:/target[[:space:]]*$' "the binaries named-volume init mount"
  assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- api_data:/data[[:space:]]*$' "the API named-volume mount"
  assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- binaries:/data/binaries:ro[[:space:]]*$' "the API binaries named-volume mount"
  assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- postgres_data:/var/lib/postgresql/data[[:space:]]*$' "the Postgres named-volume mount"
  assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- redis_data:/data[[:space:]]*$' "the Redis named-volume mount"

  assert_generated_compose_contains "${generated_file}" '      - ./data/binaries:/target' "the binaries init bind mount"
  assert_generated_compose_contains "${generated_file}" '      - ./data/api:/data' "the API data bind mount"
  assert_generated_compose_contains "${generated_file}" '      - ./data/binaries:/data/binaries:ro' "the API binaries bind mount"
  assert_generated_compose_contains "${generated_file}" '      - ./data/postgres:/var/lib/postgresql/data' "the Postgres data bind mount"
  assert_generated_compose_contains "${generated_file}" '      - ./data/redis:/data' "the Redis data bind mount"

  if grep -Eq '^  caddy:[[:space:]]*$' "${generated_file}"; then
    assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- caddy_data:/data[[:space:]]*$' "the Caddy data named-volume mount"
    assert_generated_compose_absent_regex "${generated_file}" '^[[:space:]]+- caddy_config:/config[[:space:]]*$' "the Caddy config named-volume mount"
    assert_generated_compose_contains "${generated_file}" '      - ./data/caddy/data:/data' "the Caddy data bind mount"
    assert_generated_compose_contains "${generated_file}" '      - ./data/caddy/config:/config' "the Caddy config bind mount"
  fi
}

write_local_storage_compose_file() {
  local tmp

  ensure_local_storage_dirs

  if grep -q 'Generated by scripts/guided-setup.sh for local storage mode' "${COMPOSE_FILE}"; then
    log "${COMPOSE_FILE} is already configured for local ./data storage."
    return
  fi

  tmp="$(mktemp "${COMPOSE_FILE}.tmp.XXXXXX")"
  backup_file "${COMPOSE_FILE}"

  if ! awk '
    NR == 1 {
      print "# Generated by scripts/guided-setup.sh for local storage mode."
      print "# Persistent container data is stored under ./data next to this Compose file."
    }

    /^volumes:[[:space:]]*$/ {
      skip_top_volumes = 1
      next
    }

    skip_top_volumes && /^secrets:[[:space:]]*$/ {
      skip_top_volumes = 0
      print
      next
    }

    skip_top_volumes {
      next
    }

    {
      gsub("- binaries:/target", "- ./data/binaries:/target")
      gsub("- caddy_data:/data", "- ./data/caddy/data:/data")
      gsub("- caddy_config:/config", "- ./data/caddy/config:/config")
      gsub("- api_data:/data", "- ./data/api:/data")
      gsub("- binaries:/data/binaries:ro", "- ./data/binaries:/data/binaries:ro")
      gsub("- postgres_data:/var/lib/postgresql/data", "- ./data/postgres:/var/lib/postgresql/data")
      gsub("- redis_data:/data", "- ./data/redis:/data")
      print
    }
  ' "${COMPOSE_FILE}" > "${tmp}"; then
    rm -f "${tmp}"
    fail "Failed to generate local-storage Compose file; ${COMPOSE_FILE} was left unchanged."
  fi

  assert_local_storage_compose_rewrite "${tmp}"
  if ! mv "${tmp}" "${COMPOSE_FILE}"; then
    rm -f "${tmp}"
    fail "Failed to replace ${COMPOSE_FILE} with generated local-storage Compose file."
  fi
  log "Generated ${COMPOSE_FILE} with local ./data bind mounts."
}

print_npm_advanced_tab_config() {
  cat <<EOF
# Breeze NPM Advanced config.
# Covers Breeze self-host API/Web traffic in NPM-safe syntax.
# If you raise MAX_TRANSFER_SIZE_MB, raise client_max_body_size to match.
client_max_body_size 512m;
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
proxy_buffering off;
proxy_request_buffering off;

location = /oauth/consent {
    proxy_pass http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location /oauth/consent/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location = /activate/complete {
    proxy_pass http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location /activate/complete/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location = /api {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location /api/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
}

location = /oauth {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /oauth/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /.well-known/oauth-authorization-server {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /.well-known/oauth-protected-resource {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /.well-known/jwks.json {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /s {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /s/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /i {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /i/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /health {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /health/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /ready {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /metrics {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /metrics/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location = /activate {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

location /activate/ {
    proxy_pass http://${PROXY_TARGET_HOST}:${API_HOST_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
EOF
}

write_reverse_proxy_guide() {
  local mode="$1"
  local app_host="$2"
  local tmp
  tmp="$(mktemp "${PROXY_GUIDE_FILE}.tmp.XXXXXX")"

  cat > "${tmp}" <<EOF
# Breeze Reverse Proxy Setup

Generated by \`scripts/guided-setup.sh\` for: ${mode}

## Published Breeze Services

The generated docker-compose.yml removes Breeze's packaged Caddy and publishes
the app services directly on the host. Bind IP and host ports are controlled
from .env:

- API: \`http://${PROXY_TARGET_HOST}:${API_HOST_PORT}\`
- Web dashboard: \`http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT}\`
- Docker bind address: \`${PROXY_BIND_HOST}\`
- Public hostname: \`${app_host}\`

Your reverse proxy must route API/OAuth/agent paths to the API service and all
other dashboard paths to the Web service.

If the reverse proxy is not on the Breeze host, allow ports \`${API_HOST_PORT}\`
and \`${WEB_HOST_PORT}\` through the host firewall only from the proxy's source
IP/CIDR.
EOF

  if [[ "${REVERSE_PROXY_MODE}" == "npm" ]]; then
    cat >> "${tmp}" <<EOF
## Nginx Proxy Manager

Create one Proxy Host for \`${app_host}\`.

Details tab:

- Domain Names: \`${app_host}\`
- Scheme: \`http\`
- Forward Hostname / IP: \`${PROXY_TARGET_HOST}\`
- Forward Port: \`${WEB_HOST_PORT}\`
- Websockets Support: enabled
- Block Common Exploits: enabled
- Cache Assets: disabled
- SSL: request or select the certificate for \`${app_host}\`
- Force SSL: enabled
- HTTP/2 Support: enabled

Advanced tab copy/paste. This includes Breeze's API/Web path routing, so you
do not need to add separate NPM Custom Locations:

\`\`\`nginx
$(print_npm_advanced_tab_config)
\`\`\`
EOF
  fi

  cat >> "${tmp}" <<EOF
## Generic Reverse Proxy Requirements

API upstream: \`http://${PROXY_TARGET_HOST}:${API_HOST_PORT}\`.

Web upstream: \`http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT}\`.

Use your proxy's path matching, middleware, or router rules to split traffic
between those two upstreams.

Route these API paths to the API upstream:

- \`/api/*\`
- \`/s/*\`
- \`/health\`, \`/health/*\`, \`/ready\`
- \`/metrics/*\`
- \`/i/*\`
- \`/oauth/*\`, except \`/oauth/consent\` and \`/oauth/consent/*\`
- \`/.well-known/oauth-authorization-server\`
- \`/.well-known/oauth-protected-resource\`
- \`/.well-known/jwks.json\`
- \`/activate/*\`, except the web activation routes below

Route these web paths to the Web upstream:

- \`/oauth/consent\`
- \`/oauth/consent/*\`
- \`/activate/complete\`
- \`/activate/*\` when the query string includes \`status=...\`
- \`/\` catch-all

Disable buffering and use long read/send timeouts for streaming paths:

- \`/api/v1/mcp/sse\`
- \`/api/v1/helper/chat/sessions/*/messages\`
- \`/api/v1/ai/sessions/*/stream\`

Enable WebSocket upgrades for all proxied paths.
EOF

  if [[ -f "${PROXY_GUIDE_FILE}" ]]; then
    backup_file "${PROXY_GUIDE_FILE}"
  fi
  if [[ ! -s "${tmp}" ]]; then
    rm -f "${tmp}"
    fail "Generated reverse proxy guide was empty; ${PROXY_GUIDE_FILE} was left unchanged."
  fi
  if ! mv "${tmp}" "${PROXY_GUIDE_FILE}"; then
    rm -f "${tmp}"
    fail "Failed to replace ${PROXY_GUIDE_FILE} with generated reverse proxy guide."
  fi
}

select_proxy_target_host() {
  local existing detected ips=()
  local index choice manual status

  existing="$(get_env_value "BREEZE_PROXY_TARGET_HOST")"
  if [[ -n "${existing}" ]]; then
    PROXY_TARGET_HOST="${existing}"
  fi

  if [[ -n "${PROXY_TARGET_HOST}" ]]; then
    while true; do
      if ! read_prompt choice "Use existing reverse-proxy target host ${PROXY_TARGET_HOST}? [Y/n] or b to go back: "; then
        fail "No input received for reverse-proxy target host reuse."
      fi
      choice="${choice:-yes}"
      case "${choice}" in
        y|Y|yes|YES|Yes) return ;;
        n|N|no|NO|No) break ;;
        b|B|back|Back|BACK) return "${BACK_STATUS}" ;;
        *) log "Choose yes, no, or b to go back." ;;
      esac
    done
  fi

  while IFS= read -r detected; do
    [[ -n "${detected}" ]] && ips+=("${detected}")
  done < <(scan_local_ipv4_addresses)

  subsection "Reverse Proxy Target"
  log "Select the IP/host your third-party reverse proxy should connect to."
  log "This is the Breeze upstream address used by NPM or another reverse proxy."
  log "Use 127.0.0.1 only when the reverse proxy runs on the same Breeze machine."
  if (( ${#ips[@]} > 0 )); then
    log ""
    log "Detected local IPv4 addresses:"
    index=1
    for detected in "${ips[@]}"; do
      log "  ${index}) ${detected}"
      index=$((index + 1))
    done
  else
    warn "No non-loopback local IPv4 addresses were detected."
  fi
  log ""
  log "  l) 127.0.0.1 (same-host proxy)"
  log "  m) Enter manually"
  log "  b) Back to reverse proxy choice"

  while true; do
    if (( ${#ips[@]} > 0 )); then
      if ! read_prompt choice "Breeze upstream selection [1]: "; then
        fail "No input received for Breeze instance IP."
      fi
      choice="${choice:-1}"
    else
      if ! read_prompt choice "Breeze upstream selection [m]: "; then
        fail "No input received for Breeze instance IP."
      fi
      choice="${choice:-m}"
    fi

    case "${choice}" in
      b|B|back|Back|BACK)
        return "${BACK_STATUS}"
        ;;
      l|L|local|localhost)
        PROXY_TARGET_HOST="127.0.0.1"
        return
        ;;
      m|M|manual)
        if manual="$(prompt_host_or_back "BREEZE_PROXY_TARGET_HOST" "Manual Breeze instance IP or hostname for proxy upstreams" "" true "reverse proxy choice")"; then
          :
        else
          status=$?
          if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
            return "${BACK_STATUS}"
          fi
          return "${status}"
        fi
        PROXY_TARGET_HOST="${manual}"
        return
        ;;
      ''|*[!0-9]*)
        log "Choose a number, l, m, or b."
        ;;
      *)
        if (( choice >= 1 && choice <= ${#ips[@]} )); then
          PROXY_TARGET_HOST="${ips[$((choice - 1))]}"
          return
        fi
        log "Choose a number from the detected list, l, m, or b."
        ;;
    esac
  done
}

docker_bridge_gateway() {
  # Docker assigns the .1 address of a user-defined bridge network's subnet as the
  # gateway; the api container sees that gateway as the source for a same-host
  # proxy's NAT'd packets. Honor an exported BREEZE_DOCKER_SUBNET override (the
  # same var docker-compose.yml reads as ${BREEZE_DOCKER_SUBNET:-172.31.0.0/24});
  # fall back to the compose default when it is unset or not a well-formed
  # A.B.C.D/NN whose .1 is a valid IPv4 address. Users who override the subnet
  # only in .env can instead set TRUSTED_PROXY_CIDRS explicitly (honored above).
  # Parameter expansion, not a regex capture: bash 3.2 (macOS) populates
  # BASH_REMATCH unreliably for this pattern, so strip the CIDR suffix and the
  # last octet with ${var%...} instead. is_ipv4_address then validates the result.
  local subnet base prefix gateway
  subnet="${BREEZE_DOCKER_SUBNET:-172.31.0.0/24}"
  base="${subnet%/*}"   # A.B.C.D/NN -> A.B.C.D
  prefix="${base%.*}"   # A.B.C.D    -> A.B.C  (unchanged if base has no dot)
  gateway="${prefix}.1"
  if [[ "${base}" != "${prefix}" ]] && is_ipv4_address "${gateway}"; then
    printf '%s' "${gateway}"
    return
  fi
  printf '%s' "172.31.0.1"
}

default_external_proxy_cidrs() {
  local existing target

  existing="$(get_env_value "BREEZE_EXTERNAL_PROXY_CIDRS")"
  if looks_like_placeholder "${existing}"; then
    existing=""
  fi
  if [[ -n "${existing}" ]]; then
    printf '%s' "${existing}"
    return
  fi

  target="${PROXY_TARGET_HOST}"
  case "${target}" in
    127.*|localhost)
      # In external-proxy mode the API is reached via a PUBLISHED host port, so a
      # same-host proxy's packets are NAT'd through the breeze bridge network and
      # the api container sees the bridge GATEWAY as the source — not 127.0.0.1,
      # which would match nothing and silently disable real-client-IP trust. Use
      # the gateway (.1) of the breeze network's subnet, honoring a
      # BREEZE_DOCKER_SUBNET override the same way docker-compose.yml does.
      printf '%s/32' "$(docker_bridge_gateway)"
      return
      ;;
  esac

  printf '%s' ""
}

is_ipv4_address() {
  local ip="$1"
  local octet
  local -a octets=()

  [[ "${ip}" =~ ^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<< "${ip}"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "${octet}" =~ ^[0-9]+$ ]] || return 1
    (( 10#${octet} >= 0 && 10#${octet} <= 255 )) || return 1
  done
  return 0
}

proxy_source_to_cidr_default() {
  local source="$1"

  case "${source}" in
    127.*|localhost)
      # A same-host proxy reaches the API via a published port, so the api
      # container sees the breeze bridge network's gateway (.1 of its subnet,
      # default 172.31.0.0/24), never loopback. See default_external_proxy_cidrs
      # and docker_bridge_gateway for the full rationale.
      printf '%s/32' "$(docker_bridge_gateway)"
      return
      ;;
  esac

  if [[ "${source}" == */* || "${source}" == *,* ]]; then
    printf '%s' "${source}"
    return
  fi

  if is_ipv4_address "${source}"; then
    printf '%s/32' "${source}"
    return
  fi

  if [[ "${source}" == *:* ]]; then
    printf '%s/128' "${source}"
    return
  fi

  printf '%s' "${source}"
}

is_private_or_local_ipv4() {
  local ip="$1"
  local first second _third _fourth

  is_ipv4_address "${ip}" || return 1
  IFS=. read -r first second _third _fourth <<< "${ip}"
  (( 10#${first} == 10 )) && return 0
  (( 10#${first} == 127 )) && return 0
  (( 10#${first} == 172 && 10#${second} >= 16 && 10#${second} <= 31 )) && return 0
  (( 10#${first} == 192 && 10#${second} == 168 )) && return 0
  (( 10#${first} == 169 && 10#${second} == 254 )) && return 0
  (( 10#${first} == 100 && 10#${second} >= 64 && 10#${second} <= 127 )) && return 0
  return 1
}

is_private_or_local_ipv6() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "${lower}" == "::1" || "${lower}" == fc* || "${lower}" == fd* || "${lower}" == fe80:* ]]
}

trim_spaces() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

validate_proxy_cidrs() {
  local value="$1"
  local entry network prefix version max_prefix
  local -a entries=()

  IFS=, read -r -a entries <<< "${value}"
  if [[ "${#entries[@]}" -eq 0 ]]; then
    warn "TRUSTED_PROXY_CIDRS is required for external reverse proxy mode."
    return 1
  fi

  for entry in "${entries[@]}"; do
    entry="$(trim_spaces "${entry}")"
    if [[ -z "${entry}" ]]; then
      warn "TRUSTED_PROXY_CIDRS contains an empty entry."
      return 1
    fi

    case "${entry}" in
      private_ranges|0.0.0.0/0|::/0)
        warn "TRUSTED_PROXY_CIDRS must not trust all private ranges or all source IPs."
        return 1
        ;;
    esac

    network="${entry%%/*}"
    prefix=""
    if [[ "${entry}" == */* ]]; then
      prefix="${entry#*/}"
    fi

    if is_ipv4_address "${network}"; then
      version=4
      max_prefix=32
    elif [[ "${network}" == *:* ]]; then
      version=6
      max_prefix=128
    else
      warn "TRUSTED_PROXY_CIDRS entry is not an IP/CIDR: ${entry}"
      return 1
    fi

    if [[ -n "${prefix}" ]]; then
      if [[ ! "${prefix}" =~ ^[0-9]+$ || "${prefix}" -lt 0 || "${prefix}" -gt "${max_prefix}" ]]; then
        warn "TRUSTED_PROXY_CIDRS entry has an invalid prefix: ${entry}"
        return 1
      fi

      if [[ "${version}" -eq 4 ]] && is_private_or_local_ipv4 "${network}" && [[ "${prefix}" -ne 32 ]]; then
        warn "Private IPv4 reverse proxy sources must be exact hosts. Enter the proxy host IP with /32, not a LAN-wide CIDR like ${entry}."
        return 1
      fi

      if [[ "${version}" -eq 6 ]] && is_private_or_local_ipv6 "${network}" && [[ "${prefix}" -ne 128 ]]; then
        warn "Private IPv6 reverse proxy sources must be exact hosts. Enter the proxy host IP with /128, not a broad CIDR like ${entry}."
        return 1
      fi
    fi
  done

  return 0
}

is_port_number() {
  local value="$1"

  [[ "${value}" =~ ^[0-9]+$ ]] || return 1
  (( 10#${value} >= 1 && 10#${value} <= 65535 ))
}

is_host_name_or_ipv4() {
  local value="$1"

  [[ -n "${value}" ]] || return 1
  [[ ! "${value}" =~ [[:space:]] ]] || return 1
  [[ "${value}" != *[:/?#@]* ]] || return 1
  [[ "${#value}" -le 253 ]] || return 1
  [[ "${value}" == "localhost" ]] && return 0
  is_ipv4_address "${value}" && return 0
  [[ "${value}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]
}

is_postgres_identifier() {
  # A safe, unquoted Postgres role/database name. Restricting to this keeps BOTH
  # the .env DATABASE_URL (host tooling) AND the compose-built container URL
  # (postgresql://${POSTGRES_USER}:...@postgres/${POSTGRES_DB}) well-formed —
  # the installer cannot encode the value inside the compose file, so validating
  # here is the only fix that covers both. Max 63 bytes per Postgres identifier.
  local value="$1"
  [[ "${value}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]
}

is_bind_host() {
  local value="$1"

  is_ipv4_address "${value}"
}

is_http_origin() {
  local value="$1"
  local rest host port

  [[ -n "${value}" ]] || return 1
  [[ ! "${value}" =~ [[:space:]] ]] || return 1
  [[ "${value}" != *,* ]] || return 1

  case "${value}" in
    http://*) rest="${value#http://}" ;;
    https://*) rest="${value#https://}" ;;
    *) return 1 ;;
  esac

  [[ -n "${rest}" ]] || return 1
  [[ "${rest}" != */* && "${rest}" != *\?* && "${rest}" != *#* ]] || return 1

  host="${rest}"
  port=""
  if [[ "${rest}" == *:* ]]; then
    host="${rest%:*}"
    port="${rest##*:}"
    [[ "${host}" != *:* ]] || return 1
    is_port_number "${port}" || return 1
  fi

  is_host_name_or_ipv4 "${host}"
}

validate_origin_list() {
  local value="$1"
  local origin
  local -a origins=()

  IFS=, read -r -a origins <<< "${value}"
  [[ "${#origins[@]}" -gt 0 ]] || return 1

  for origin in "${origins[@]}"; do
    origin="$(trim_spaces "${origin}")"
    is_http_origin "${origin}" || return 1
  done
}

is_bool_value() {
  case "$1" in
    true|false|TRUE|FALSE|True|False) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_bool_value() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

set_proxy_cidr_default_from_source() {
  local source="$1"

  PROXY_CIDR_DEFAULT="$(proxy_source_to_cidr_default "${source}")"
  validate_proxy_cidrs "${PROXY_CIDR_DEFAULT}"
}

select_proxy_cidr_default_or_back() {
  local choice source_host

  PROXY_CIDR_DEFAULT="$(default_external_proxy_cidrs)"
  if [[ -n "${PROXY_CIDR_DEFAULT}" ]]; then
    return
  fi

  subsection "Proxy Location"
  log "Where does ${REVERSE_PROXY_LABEL} run?"
  log "  1) Same machine as Breeze (prefill $(proxy_source_to_cidr_default "${PROXY_TARGET_HOST}"))"
  log "  2) Different machine/VM/container host (you will enter the NPM/proxy IP next)"
  log "  b) Back to reverse proxy choice"

  while true; do
    if ! read_prompt choice "Proxy location [2]: "; then
      fail "No input received for reverse proxy location."
    fi
    choice="${choice:-2}"
    case "${choice}" in
      1|same|same-host|local)
        if set_proxy_cidr_default_from_source "${PROXY_TARGET_HOST}"; then
          return
        fi
        ;;
      2|different|remote|other)
        while true; do
          if ! read_prompt source_host "Proxy source IP as Breeze sees it, or b to go back: "; then
            fail "No input received for reverse proxy source IP."
          fi
          if is_back_answer "${source_host}"; then
            return "${BACK_STATUS}"
          fi
          if [[ -z "${source_host}" ]]; then
            warn "Reverse proxy source IP is required when the proxy runs on another machine."
            continue
          fi
          if set_proxy_cidr_default_from_source "${source_host}"; then
            return
          fi
        done
        ;;
      b|B|back|Back|BACK)
        return "${BACK_STATUS}"
        ;;
      *)
        log "Choose 1, 2, or b."
        ;;
    esac
  done
}

prompt_proxy_cidrs_or_back() {
  local default_value="$1"
  local answer

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "Exact reverse proxy source CIDR(s) allowed to send real client IP headers (BREEZE_EXTERNAL_PROXY_CIDRS) [${default_value}] or b to go back to reverse proxy choice: "; then
        fail "No input received for BREEZE_EXTERNAL_PROXY_CIDRS."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "Exact reverse proxy source CIDR(s) allowed to send real client IP headers (BREEZE_EXTERNAL_PROXY_CIDRS) or b to go back to reverse proxy choice: "; then
        fail "No input received for BREEZE_EXTERNAL_PROXY_CIDRS."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
    fi

    if validate_proxy_cidrs "${answer}"; then
      set_env_value "BREEZE_EXTERNAL_PROXY_CIDRS" "${answer}"
      printf '%s' "${answer}"
      return
    fi
  done
}

select_reverse_proxy() {
  if [[ "${YES_MODE}" == "true" ]]; then
    section "Reverse Proxy"
    REVERSE_PROXY_MODE="caddy"
    REVERSE_PROXY_LABEL="Packaged Caddy"
    remove_generated_proxy_override_if_present
    if ! grep -q '^  caddy:' "${COMPOSE_FILE}"; then
      fail "${COMPOSE_FILE} is configured for an external reverse proxy and no longer contains packaged Caddy. Restore a fresh Compose file with --download before selecting packaged Caddy."
    fi
    log "Using packaged Caddy direct mode."
    return
  fi

  while true; do
    local bind_default choice status

    section "Reverse Proxy"
    subsection "Traffic Entry Point"
    log "Choose how public HTTPS traffic reaches Breeze:"
    log "  1) Packaged Caddy direct (automatic HTTPS on ports 80/443)"
    log "  2) Nginx Proxy Manager in front of Breeze"
    log "  3) Other reverse proxy (generic nginx, Traefik, HAProxy, etc. requirements)"
    log "  b) Back to secret workflow"

    while true; do
      if ! read_prompt choice "Reverse proxy option [1]: "; then
        fail "No input received for reverse proxy selection."
      fi
      choice="${choice:-1}"
      case "${choice}" in
        1)
          REVERSE_PROXY_MODE="caddy"
          REVERSE_PROXY_LABEL="Packaged Caddy"
          remove_generated_proxy_override_if_present
          if ! grep -q '^  caddy:' "${COMPOSE_FILE}"; then
            fail "${COMPOSE_FILE} is configured for an external reverse proxy and no longer contains packaged Caddy. Restore a fresh Compose file with --download before selecting packaged Caddy."
          fi
          log "Selected packaged Caddy direct mode."
          return
          ;;
        2)
          REVERSE_PROXY_MODE="npm"
          REVERSE_PROXY_LABEL="Nginx Proxy Manager"
          break
          ;;
        3)
          REVERSE_PROXY_MODE="custom"
          REVERSE_PROXY_LABEL="Other reverse proxy"
          break
          ;;
        b|B|back|Back|BACK)
          return "${BACK_STATUS}"
          ;;
        *)
          log "Choose 1, 2, 3, or b."
          ;;
      esac
    done

    if select_proxy_target_host; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi
    set_env_value "BREEZE_PROXY_TARGET_HOST" "${PROXY_TARGET_HOST}"

    section "Breeze Listener"
    subsection "Docker Host Bind"
    log "These settings control where Breeze publishes the API/Web ports for ${REVERSE_PROXY_LABEL}."
    if [[ "${PROXY_TARGET_HOST}" == "127.0.0.1" || "${PROXY_TARGET_HOST}" == "localhost" ]]; then
      log "Use 127.0.0.1 only when ${REVERSE_PROXY_LABEL} runs on this same machine, or 0.0.0.0 for all interfaces."
    else
      log "Use ${PROXY_TARGET_HOST} for LAN access from your proxy host, or 0.0.0.0 for all interfaces."
    fi
    bind_default="${PROXY_TARGET_HOST}"
    if ! is_bind_host "${bind_default}"; then
      bind_default="0.0.0.0"
    fi
    if PROXY_BIND_HOST="$(prompt_bind_host_or_back "BREEZE_PROXY_BIND_HOST" "Breeze bind IP for API/Web host ports" "${bind_default}" true "reverse proxy choice")"; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi
    if API_HOST_PORT="$(prompt_port_or_back "BREEZE_API_HOST_PORT" "Breeze API host port" "${API_HOST_PORT}" true "reverse proxy choice")"; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi
    if WEB_HOST_PORT="$(prompt_port_or_back "BREEZE_WEB_HOST_PORT" "Breeze Web dashboard host port" "${WEB_HOST_PORT}" true "reverse proxy choice")"; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi
    subsection "Proxy Upstreams"
    log "Proxy upstreams:"
    log "  API: http://${PROXY_TARGET_HOST}:${API_HOST_PORT}"
    log "  Web: http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT}"

    section "Trusted Proxy Source"
    subsection "Real Client IP Trust"
    log "This controls which proxy can send real client IP headers to Breeze."
    log "Use the exact proxy host IP/CIDR: /32 for private IPv4, /128 for private IPv6."
    if [[ "${PROXY_TARGET_HOST}" != "127."* && "${PROXY_TARGET_HOST}" != "localhost" ]]; then
      log "For another NPM host, use the NPM machine's IP, not the Breeze IP or LAN subnet."
    fi
    if select_proxy_cidr_default_or_back; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi
    if REVERSE_PROXY_EXTERNAL_CIDRS="$(prompt_proxy_cidrs_or_back "${PROXY_CIDR_DEFAULT}")"; then
      :
    else
      status=$?
      if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
        continue
      fi
      return "${status}"
    fi

    return
  done
}

select_storage_mode() {
  local choice normalized

  case "${STORAGE_MODE}" in
    docker|volume|volumes|named|named-volumes)
      STORAGE_MODE="docker"
      ;;
    local|bind|bind-mounts|binds)
      STORAGE_MODE="local"
      ;;
    "")
      ;;
    *)
      fail "BREEZE_SETUP_STORAGE_MODE must be docker or local."
      ;;
  esac

  section "Storage"

  if [[ "${YES_MODE}" == "true" && -z "${STORAGE_MODE}" ]]; then
    STORAGE_MODE="docker"
  fi

  if [[ -z "${STORAGE_MODE}" ]]; then
    subsection "Persistent Data"
    log "Choose where Breeze should store persistent container data:"
    log "  1) Docker named volumes (recommended, Docker manages the data path)"
    log "  2) Local ./data subdirectories beside docker-compose.yml"
    log "  b) Back to reverse proxy choice"

    while true; do
      if ! read_prompt choice "Storage option [1]: "; then
        fail "No input received for storage selection."
      fi
      choice="${choice:-1}"
      normalized="$(printf '%s' "${choice}" | tr '[:upper:]' '[:lower:]')"
      case "${normalized}" in
        1|docker|volume|volumes|named|named-volumes)
          STORAGE_MODE="docker"
          break
          ;;
        2|local|bind|bind-mounts|binds)
          STORAGE_MODE="local"
          break
          ;;
        b|back|prev|previous)
          return "${BACK_STATUS}"
          ;;
        *)
          log "Choose 1 for Docker named volumes, 2 for local ./data subdirectories, or b to go back."
          ;;
      esac
    done
  fi

  if [[ "${STORAGE_MODE}" == "local" ]]; then
    STORAGE_MODE_LABEL="${WORK_DIR}/data subdirectories"
    log "Selected local ./data directory storage."
    return
  fi

  STORAGE_MODE_LABEL="Docker named volumes"
  if grep -q 'Generated by scripts/guided-setup.sh for local storage mode' "${COMPOSE_FILE}"; then
    fail "${COMPOSE_FILE} is already configured for local ./data bind mounts. Restore a fresh Compose file with --download before switching back to Docker named volumes."
  fi
  log "Selected Docker named volume storage."
}

reset_secret_mode_for_back() {
  if [[ -z "${BREEZE_SETUP_SECRET_MODE:-}" && "${YES_MODE}" != "true" ]]; then
    SECRET_MODE=""
  fi
}

reset_storage_mode_for_back() {
  if [[ -z "${BREEZE_SETUP_STORAGE_MODE:-}" && "${YES_MODE}" != "true" ]]; then
    STORAGE_MODE=""
    STORAGE_MODE_LABEL="Docker named volumes"
  fi
}

configure_setup_choices() {
  local step="secret"
  local status

  while true; do
    case "${step}" in
      secret)
        select_secret_mode
        step="proxy"
        ;;
      proxy)
        if select_reverse_proxy; then
          step="storage"
        else
          status=$?
          if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
            reset_secret_mode_for_back
            step="secret"
          else
            return "${status}"
          fi
        fi
        ;;
      storage)
        if select_storage_mode; then
          return
        else
          status=$?
          if [[ "${status}" -eq "${BACK_STATUS}" ]]; then
            reset_storage_mode_for_back
            step="proxy"
          else
            return "${status}"
          fi
        fi
        ;;
      *)
        fail "Unknown setup selection step: ${step}"
        ;;
    esac
  done
}

apply_proxy_compose_file() {
  remove_generated_proxy_override_if_present

  if [[ "${REVERSE_PROXY_MODE}" == "caddy" ]]; then
    if ! grep -q '^  caddy:' "${COMPOSE_FILE}"; then
      fail "${COMPOSE_FILE} is configured for an external reverse proxy and no longer contains packaged Caddy. Restore a fresh Compose file with --download before selecting packaged Caddy."
    fi
    return
  fi

  write_external_proxy_compose_file
  log "Generated ${COMPOSE_FILE} for external reverse proxy mode."
}

ensure_packaged_caddy_assets() {
  if [[ "${REVERSE_PROXY_MODE}" != "caddy" ]]; then
    return
  fi

  if [[ -f "${CADDYFILE_FILE}" ]]; then
    log "Using packaged Caddyfile: ${CADDYFILE_FILE}"
    return
  fi

  if [[ -e "${CADDYFILE_FILE}" ]]; then
    fail "${CADDYFILE_FILE} exists but is not a regular file. Remove it before using packaged Caddy."
  fi

  if [[ "${DOWNLOAD_MODE}" == "never" ]]; then
    fail "Missing ${CADDYFILE_FILE}. Packaged Caddy mode requires docker/Caddyfile.prod; rerun without --no-download or provide the file."
  fi

  download_template "docker/Caddyfile.prod"
}

apply_storage_compose_file() {
  if [[ "${STORAGE_MODE}" == "local" ]]; then
    write_local_storage_compose_file
    return
  fi

  if grep -q 'Generated by scripts/guided-setup.sh for local storage mode' "${COMPOSE_FILE}"; then
    fail "${COMPOSE_FILE} is already configured for local ./data bind mounts. Restore a fresh Compose file with --download before switching back to Docker named volumes."
  fi
}

list_existing_breeze_containers() {
  docker ps -a --format '{{.Names}}' \
    | awk '/^breeze-(api|web|postgres|redis|caddy|coturn|binaries-init)$/ { print }'
}

space_join_lines() {
  tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

compose_project_name() {
  local configured name

  configured="$(get_env_value "COMPOSE_PROJECT_NAME")"
  name="${COMPOSE_PROJECT_NAME:-${configured:-$(basename "${WORK_DIR}")}}"
  name="$(sanitize_compose_project_name "${name}")"
  if [[ -z "${name}" ]]; then
    name="breeze"
  fi
  printf '%s' "${name}"
}

postgres_named_volume() {
  printf '%s_postgres_data' "$(compose_project_name)"
}

local_postgres_data_has_files() {
  local dir="${WORK_DIR}/data/postgres"
  [[ -d "${dir}" ]] || return 1
  find "${dir}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

detect_existing_postgres_storage() {
  local volume_name

  if [[ "${STORAGE_MODE}" == "local" ]]; then
    if local_postgres_data_has_files; then
      printf '%s' "${WORK_DIR}/data/postgres"
      return 0
    fi
    return 1
  fi

  volume_name="$(postgres_named_volume)"
  if docker volume inspect "${volume_name}" >/dev/null 2>&1; then
    printf '%s' "${volume_name}"
    return 0
  fi
  return 1
}

reset_existing_postgres_storage() {
  local storage="$1"
  if dry_run_enabled; then
    dry_run_log "Would delete existing Postgres storage: ${storage}"
    return
  fi

  if docker container inspect breeze-postgres >/dev/null 2>&1; then
    fail "breeze-postgres already exists. Stop and remove the old Breeze containers before deleting Postgres storage."
  fi

  if [[ "${STORAGE_MODE}" == "local" ]]; then
    rm -rf "${storage}"
    mkdir -p "${storage}"
    log "Deleted and recreated local Postgres data directory: ${storage}"
    return
  fi

  docker volume rm "${storage}" >/dev/null
  log "Deleted Docker Postgres volume: ${storage}"
}

check_existing_installation_conflicts() {
  local containers storage action

  if dry_run_enabled; then
    section "Existing Installation"
    dry_run_log "Skipping existing container and Postgres storage checks."
    return
  fi

  containers="$(list_existing_breeze_containers | space_join_lines)"
  if [[ -n "${containers}" ]]; then
    section "Existing Breeze Containers"
    warn "Found existing Breeze containers: ${containers}"
    log "The bundled Compose file uses fixed container names, so it cannot run side-by-side with another Breeze stack on this host."
    if [[ "${ENV_FILE_CREATED}" == "true" ]]; then
      fail "This run created a fresh .env while existing Breeze containers are present. Reuse the original .env/passwords, or stop and remove the old test stack before continuing."
    fi
    log "Using an existing .env; setup will preserve existing secrets unless you change them."
  fi

  if ! storage="$(detect_existing_postgres_storage)"; then
    return
  fi

  section "Existing Postgres Data"
  warn "Found existing Postgres storage: ${storage}"
  log "Postgres only uses POSTGRES_PASSWORD when the database is first initialized."
  log "If setup creates a new .env with a new POSTGRES_PASSWORD, the API will fail to log into this existing database."

  if [[ "${ENV_FILE_CREATED}" != "true" ]]; then
    log "Using an existing .env; keep the existing Postgres password unless you intentionally reset the database."
    return
  fi

  if [[ "${YES_MODE}" == "true" ]]; then
    fail "Existing Postgres storage cannot be reused with a freshly generated .env in --yes mode."
  fi

  log ""
  log "Choose what to do:"
  log "  1) Stop setup so you can recover/reuse the old .env or password"
  log "  2) Delete existing Postgres storage and continue with a fresh empty database"

  while true; do
    if ! read_prompt action "Existing Postgres data action [1]: "; then
      fail "No input received for existing Postgres data action."
    fi
    action="${action:-1}"
    case "${action}" in
      1|stop|quit|q)
        fail "Stopped before generating a new database password for existing Postgres storage."
        ;;
      2|delete|reset|fresh)
        warn "This deletes the existing Breeze Postgres database for this Compose project."
        if ask_yes_no "Delete existing Postgres storage now?" "no"; then
          reset_existing_postgres_storage "${storage}"
          return
        fi
        ;;
      *)
        log "Choose 1 to stop or 2 to delete existing Postgres storage."
        ;;
    esac
  done
}

materialize_env_from_example() {
  local tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

  if ! awk '
    function parse_active_key(line, normalized, parts) {
      normalized = line
      sub(/^[[:space:]]+/, "", normalized)
      if (normalized !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      split(normalized, parts, "=")
      return parts[1]
    }

    function parse_commented_key(line, normalized, parts) {
      normalized = line
      sub(/^[[:space:]]*#/, "", normalized)
      if (normalized ~ /^ /) {
        sub(/^ /, "", normalized)
        if (normalized ~ /^ /) return ""
      }
      if (normalized !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      split(normalized, parts, "=")
      return parts[1]
    }

    FNR == 1 {
      pass += 1
    }

    pass == 1 {
      key = parse_active_key($0)
      if (key != "") {
        normalized = $0
        sub(/^[[:space:]]+/, "", normalized)
        values[key] = substr(normalized, length(key) + 2)
        if (!(key in ordered)) {
          ordered[key] = 1
          order[++order_count] = key
        }
      }
      next
    }

    pass == 2 {
      key = parse_active_key($0)
      if (key != "") {
        last_active_line[key] = FNR
      }
      next
    }

    pass == 3 {
      key = parse_active_key($0)
      if (key != "") {
        if (last_active_line[key] != FNR) {
          next
        }
        if (key in values) {
          print key "=" values[key]
          consumed[key] = 1
        } else {
          print
        }
        next
      }

      key = parse_commented_key($0)
      if (key != "" && key in values) {
        print
        if (!(key in last_active_line) && !(key in consumed)) {
          print key "=" values[key]
          consumed[key] = 1
        }
        next
      }

      print
    }

    END {
      extra_count = 0
      for (i = 1; i <= order_count; i += 1) {
        key = order[i]
        if (!(key in consumed)) {
          extra[++extra_count] = key
        }
      }

      if (extra_count > 0) {
        print ""
        print "# --------------------------------------------"
        print "# Additional generated settings"
        print "# --------------------------------------------"
        print "# These keys were not present as active or commented entries in .env.example."
        for (i = 1; i <= extra_count; i += 1) {
          key = extra[i]
          print key "=" values[key]
        }
      }
    }
  ' "${ENV_FILE}" "${ENV_EXAMPLE_FILE}" "${ENV_EXAMPLE_FILE}" > "${tmp}"; then
    rm -f "${tmp}"
    fail "Failed to generate updated ${ENV_FILE} from ${ENV_EXAMPLE_FILE}."
  fi

  if ! validate_env_rewrite_candidate "${tmp}" "${ENV_FILE}" "preserve"; then
    rm -f "${tmp}"
    fail "Generated .env candidate failed integrity checks; existing ${ENV_FILE} was left unchanged."
  fi

  if ! mv "${tmp}" "${ENV_FILE}"; then
    rm -f "${tmp}"
    fail "Failed to replace ${ENV_FILE} with verified .env candidate."
  fi
  if ! chmod 600 "${ENV_FILE}"; then
    fail "Failed to set secure permissions on ${ENV_FILE}."
  fi
}

strip_wrapping_quotes() {
  local value="$1"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
    # Reverse format_env_value's double-quote escaping of \ " $ `. Protect an
    # escaped backslash (\\) with a sentinel first so the single-char unescapes
    # below don't consume a backslash that was itself escaped.
    value="${value//\\\\/$'\x01'}"
    value="${value//\\\"/\"}"
    value="${value//\\\$/\$}"
    value="${value//\\\`/\`}"
    value="${value//$'\x01'/\\}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value#\'}"
    value="${value%\'}"
  fi
  printf '%s' "${value}"
}

get_env_value() {
  local key="$1"
  local value

  if [[ -e "${ENV_FILE}" && ! -f "${ENV_FILE}" ]]; then
    fail "${ENV_FILE} exists but is not a regular file; cannot read ${key}."
  fi
  [[ -f "${ENV_FILE}" ]] || fail "Missing ${ENV_FILE}; cannot read ${key}."
  [[ -r "${ENV_FILE}" ]] || fail "${ENV_FILE} is not readable; fix permissions before continuing."

  if ! value="$(
    awk -v key="${key}" '
      $0 ~ "^[[:space:]]*" key "=" {
        raw = substr($0, index($0, "=") + 1)
        sub(/^[[:space:]]+/, "", raw)
        # Only strip an inline "# comment" on UNQUOTED values; a quoted value
        # may legitimately contain " #" (\047 is a single quote). Trailing
        # whitespace is trimmed either way; strip_wrapping_quotes then removes
        # the quotes and reverses any escaping.
        first = substr(raw, 1, 1)
        if (first != "\"" && first != "\047") {
          sub(/[[:space:]]+#.*$/, "", raw)
        }
        sub(/[[:space:]]+$/, "", raw)
        found = raw
      }
      END {
        if (found != "") print found
      }
    ' "${ENV_FILE}"
  )"; then
    fail "Failed to read ${key} from ${ENV_FILE}."
  fi

  strip_wrapping_quotes "${value}"
}

format_env_value() {
  local value="$1"
  if [[ -z "${value}" ]]; then
    printf ''
    return
  fi

  if [[ "${value}" =~ ^[A-Za-z0-9_@%+=:,./{}-]+$ ]]; then
    printf '%s' "${value}"
    return
  fi

  # Values with special characters must be quoted so docker compose's dotenv
  # parser (and this installer's own read-back) treat them literally.
  #  - No single quote  -> single-quote it: fully literal in godotenv, no
  #    interpolation, nothing to escape (covers spaces, #, $, \, ", tabs).
  #  - Contains a single quote -> godotenv cannot embed one inside a
  #    single-quoted string, so double-quote and escape the chars it treats
  #    specially inside double quotes (\ " $ `); the \$ escape also blocks
  #    $-interpolation. strip_wrapping_quotes is the exact inverse.
  if [[ "${value}" != *"'"* ]]; then
    printf "'%s'" "${value}"
    return
  fi

  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "${value}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local formatted tmp
  formatted="$(format_env_value "${value}")"
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

  # Pass the formatted value via the environment, not `-v value=`: awk's -v
  # assignment processes backslash escapes, which would corrupt any value
  # containing a backslash (e.g. the \" / \$ escapes above, or a literal '\').
  if ! BREEZE_SET_ENV_VALUE="${formatted}" awk -v key="${key}" '
    BEGIN { seen = 0; value = ENVIRON["BREEZE_SET_ENV_VALUE"] }
    $0 ~ "^[[:space:]]*" key "=" {
      if (seen == 0) {
        print key "=" value
      }
      seen = 1
      next
    }
    { print }
    END {
      if (seen == 0) {
        print ""
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp}"; then
    rm -f "${tmp}"
    fail "Failed to update ${key} in ${ENV_FILE}."
  fi

  if ! validate_set_env_candidate "${tmp}" "${ENV_FILE}" "${key}" "${value}"; then
    rm -f "${tmp}"
    fail "Generated .env candidate failed integrity checks while updating ${key}; existing ${ENV_FILE} was left unchanged."
  fi

  if ! mv "${tmp}" "${ENV_FILE}"; then
    rm -f "${tmp}"
    fail "Failed to replace ${ENV_FILE} after updating ${key}."
  fi
  if ! chmod 600 "${ENV_FILE}"; then
    fail "Failed to set secure permissions on ${ENV_FILE}."
  fi
}

looks_like_placeholder() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ -z "${value}" ]] && return 0
  [[ "${value}" == *changeme* ]] && return 0
  [[ "${value}" == *change-me* ]] && return 0
  [[ "${value}" == *change_me* ]] && return 0
  [[ "${value}" == *change-in-production* ]] && return 0
  [[ "${value}" == *generate-a-random* ]] && return 0
  [[ "${value}" == *your-super-secret* ]] && return 0
  [[ "${value}" == *your-enrollment-secret* ]] && return 0
  [[ "${value}" == *yourdomain.com* ]] && return 0
  [[ "${value}" == *app.yourdomain.com* ]] && return 0
  [[ "${value}" == *breeze.yourdomain.com* ]] && return 0
  [[ "${value}" == *secure_password_change_me* ]] && return 0
  [[ "${value}" == "__generate_me__" ]] && return 0
  return 1
}

is_bootstrap_env_key() {
  local key="$1"
  local bootstrap_key
  for bootstrap_key in "${BOOTSTRAP_ENV_KEYS[@]}"; do
    [[ "${key}" == "${bootstrap_key}" ]] && return 0
  done
  return 1
}

env_active_keys() {
  local file="$1"
  awk '
    function parse_active_key(line, normalized, parts) {
      normalized = line
      sub(/^[[:space:]]+/, "", normalized)
      if (normalized !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      split(normalized, parts, "=")
      return parts[1]
    }
    {
      key = parse_active_key($0)
      if (key != "" && !seen[key]++) print key
    }
  ' "${file}"
}

env_file_value() {
  local file="$1"
  local key="$2"
  local value

  if ! value="$(
    awk -v key="${key}" '
      $0 ~ "^[[:space:]]*" key "=" {
        raw = substr($0, index($0, "=") + 1)
        sub(/^[[:space:]]+/, "", raw)
        # Only strip an inline "# comment" on UNQUOTED values; a quoted value
        # may legitimately contain " #" (\047 is a single quote). Trailing
        # whitespace is trimmed either way; strip_wrapping_quotes then removes
        # the quotes and reverses any escaping.
        first = substr(raw, 1, 1)
        if (first != "\"" && first != "\047") {
          sub(/[[:space:]]+#.*$/, "", raw)
        }
        sub(/[[:space:]]+$/, "", raw)
        found = raw
      }
      END {
        if (found != "") print found
      }
    ' "${file}"
  )"; then
    return 1
  fi

  strip_wrapping_quotes "${value}"
}

validate_env_rewrite_candidate() {
  local candidate="$1"
  local source="$2"
  local mode="${3:-preserve}"
  local keys key old_value new_value

  if [[ ! -s "${candidate}" ]]; then
    warn "Generated .env candidate is empty."
    return 1
  fi

  if ! keys="$(env_active_keys "${source}")"; then
    warn "Could not read existing keys from ${source}."
    return 1
  fi

  while IFS= read -r key; do
    [[ -n "${key}" ]] || continue

    if [[ "${mode}" == "bootstrap-scrub" ]] && is_bootstrap_env_key "${key}"; then
      if ! new_value="$(env_file_value "${candidate}" "${key}")"; then
        warn "Could not verify ${key} in generated .env candidate."
        return 1
      fi
      if [[ -n "${new_value}" ]]; then
        warn "Bootstrap cleanup candidate still contains ${key}."
        return 1
      fi
      continue
    fi

    if ! old_value="$(env_file_value "${source}" "${key}")"; then
      warn "Could not read existing value for ${key} from ${source}."
      return 1
    fi
    if looks_like_placeholder "${old_value}"; then
      continue
    fi

    if ! new_value="$(env_file_value "${candidate}" "${key}")"; then
      warn "Could not verify ${key} in generated .env candidate."
      return 1
    fi
    if [[ "${new_value}" != "${old_value}" ]]; then
      warn "Generated .env candidate did not preserve existing value for ${key}."
      return 1
    fi
  done <<< "${keys}"

  if [[ "${mode}" == "bootstrap-scrub" ]]; then
    for key in "${BOOTSTRAP_ENV_KEYS[@]}"; do
      if ! new_value="$(env_file_value "${candidate}" "${key}")"; then
        warn "Could not verify ${key} in generated .env candidate."
        return 1
      fi
      if [[ -n "${new_value}" ]]; then
        warn "Bootstrap cleanup candidate still contains ${key}."
        return 1
      fi
    done
  fi

  return 0
}

validate_set_env_candidate() {
  local candidate="$1"
  local source="$2"
  local updated_key="$3"
  local expected_value="$4"
  local keys key old_value new_value

  if [[ ! -s "${candidate}" ]]; then
    warn "Generated .env candidate is empty."
    return 1
  fi

  if ! new_value="$(env_file_value "${candidate}" "${updated_key}")"; then
    warn "Could not verify ${updated_key} in generated .env candidate."
    return 1
  fi
  if [[ "${new_value}" != "${expected_value}" ]]; then
    warn "Generated .env candidate did not set ${updated_key} correctly."
    return 1
  fi

  if ! keys="$(env_active_keys "${source}")"; then
    warn "Could not read existing keys from ${source}."
    return 1
  fi

  while IFS= read -r key; do
    [[ -n "${key}" ]] || continue
    [[ "${key}" == "${updated_key}" ]] && continue

    if ! old_value="$(env_file_value "${source}" "${key}")"; then
      warn "Could not read existing value for ${key} from ${source}."
      return 1
    fi
    if looks_like_placeholder "${old_value}"; then
      continue
    fi

    if ! new_value="$(env_file_value "${candidate}" "${key}")"; then
      warn "Could not verify ${key} in generated .env candidate."
      return 1
    fi
    if [[ "${new_value}" != "${old_value}" ]]; then
      warn "Generated .env candidate did not preserve existing value for ${key}."
      return 1
    fi
  done <<< "${keys}"

  return 0
}

write_bootstrap_scrubbed_env_file() {
  local source="$1"
  local target="$2"
  local keys_csv

  keys_csv="$(IFS=,; printf '%s' "${BOOTSTRAP_ENV_KEYS[*]}")"
  awk -v keys="${keys_csv}" '
    BEGIN {
      split(keys, parts, ",")
      for (i in parts) redact[parts[i]] = 1
    }
    function parse_active_key(line, normalized, parts) {
      normalized = line
      sub(/^[[:space:]]+/, "", normalized)
      if (normalized !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      split(normalized, parts, "=")
      return parts[1]
    }
    {
      key = parse_active_key($0)
      if (key in redact) {
        print key "="
        next
      }
      print
    }
  ' "${source}" > "${target}"
}

prompt_value() {
  local key="$1"
  local label="$2"
  local default_value="$3"
  local required="${4:-true}"
  local current answer

  current="$(get_env_value "${key}")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi
  default_value="${current:-${default_value}}"

  if [[ "${YES_MODE}" == "true" ]]; then
    if [[ -n "${default_value}" || "${required}" == "false" ]]; then
      set_env_value "${key}" "${default_value}"
      printf '%s' "${default_value}"
      return
    fi
    fail "${key} requires a value; rerun without --yes or prefill it in ${ENV_FILE}."
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "${label} (${key}) [${default_value}]: "; then
        fail "No input received for ${key}."
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "${label} (${key}): "; then
        fail "No input received for ${key}."
      fi
    fi

    if [[ -n "${answer}" || "${required}" == "false" ]]; then
      set_env_value "${key}" "${answer}"
      printf '%s' "${answer}"
      return
    fi
    warn "${key} is required."
  done
}

prompt_value_or_back() {
  local key="$1"
  local label="$2"
  local default_value="$3"
  local required="${4:-true}"
  local back_label="${5:-previous step}"
  local current answer

  current="$(get_env_value "${key}")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi
  default_value="${current:-${default_value}}"

  if [[ "${YES_MODE}" == "true" ]]; then
    if [[ -n "${default_value}" || "${required}" == "false" ]]; then
      set_env_value "${key}" "${default_value}"
      printf '%s' "${default_value}"
      return
    fi
    fail "${key} requires a value; rerun without --yes or prefill it in ${ENV_FILE}."
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "${label} (${key}) [${default_value}] or b to go back to ${back_label}: "; then
        fail "No input received for ${key}."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "${label} (${key}) or b to go back to ${back_label}: "; then
        fail "No input received for ${key}."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
    fi

    if [[ -n "${answer}" || "${required}" == "false" ]]; then
      set_env_value "${key}" "${answer}"
      printf '%s' "${answer}"
      return
    fi
    warn "${key} is required."
  done
}

prompt_validated_value() {
  local key="$1"
  local label="$2"
  local default_value="$3"
  local required="${4:-true}"
  local validator="$5"
  local expectation="$6"
  local normalizer="${7:-}"
  local current answer

  current="$(get_env_value "${key}")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi
  default_value="${current:-${default_value}}"

  if [[ "${YES_MODE}" == "true" ]]; then
    if [[ -z "${default_value}" && "${required}" == "false" ]]; then
      set_env_value "${key}" ""
      printf '%s' ""
      return
    fi
    [[ -n "${default_value}" ]] || fail "${key} requires a value; rerun without --yes or prefill it in ${ENV_FILE}."
    if ! "${validator}" "${default_value}"; then
      fail "${key} has invalid value '${default_value}'. Expected ${expectation}."
    fi
    if [[ -n "${normalizer}" ]]; then
      default_value="$("${normalizer}" "${default_value}")"
    fi
    set_env_value "${key}" "${default_value}"
    printf '%s' "${default_value}"
    return
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "${label} (${key}) [${default_value}]: "; then
        fail "No input received for ${key}."
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "${label} (${key}): "; then
        fail "No input received for ${key}."
      fi
    fi

    answer="$(trim_spaces "${answer}")"
    if [[ -z "${answer}" && "${required}" == "false" ]]; then
      set_env_value "${key}" ""
      printf '%s' ""
      return
    fi
    if [[ -z "${answer}" ]]; then
      warn "${key} is required."
      continue
    fi
    if ! "${validator}" "${answer}"; then
      warn "${key} must be ${expectation}."
      continue
    fi
    if [[ -n "${normalizer}" ]]; then
      answer="$("${normalizer}" "${answer}")"
    fi
    set_env_value "${key}" "${answer}"
    printf '%s' "${answer}"
    return
  done
}

prompt_validated_value_or_back() {
  local key="$1"
  local label="$2"
  local default_value="$3"
  local required="${4:-true}"
  local back_label="${5:-previous step}"
  local validator="$6"
  local expectation="$7"
  local normalizer="${8:-}"
  local current answer

  current="$(get_env_value "${key}")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi
  default_value="${current:-${default_value}}"

  if [[ "${YES_MODE}" == "true" ]]; then
    if [[ -z "${default_value}" && "${required}" == "false" ]]; then
      set_env_value "${key}" ""
      printf '%s' ""
      return
    fi
    [[ -n "${default_value}" ]] || fail "${key} requires a value; rerun without --yes or prefill it in ${ENV_FILE}."
    if ! "${validator}" "${default_value}"; then
      fail "${key} has invalid value '${default_value}'. Expected ${expectation}."
    fi
    if [[ -n "${normalizer}" ]]; then
      default_value="$("${normalizer}" "${default_value}")"
    fi
    set_env_value "${key}" "${default_value}"
    printf '%s' "${default_value}"
    return
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "${label} (${key}) [${default_value}] or b to go back to ${back_label}: "; then
        fail "No input received for ${key}."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "${label} (${key}) or b to go back to ${back_label}: "; then
        fail "No input received for ${key}."
      fi
      if is_back_answer "${answer}"; then
        return "${BACK_STATUS}"
      fi
    fi

    answer="$(trim_spaces "${answer}")"
    if [[ -z "${answer}" && "${required}" == "false" ]]; then
      set_env_value "${key}" ""
      printf '%s' ""
      return
    fi
    if [[ -z "${answer}" ]]; then
      warn "${key} is required."
      continue
    fi
    if ! "${validator}" "${answer}"; then
      warn "${key} must be ${expectation}."
      continue
    fi
    if [[ -n "${normalizer}" ]]; then
      answer="$("${normalizer}" "${answer}")"
    fi
    set_env_value "${key}" "${answer}"
    printf '%s' "${answer}"
    return
  done
}

prompt_port() {
  prompt_validated_value "$1" "$2" "$3" "${4:-true}" is_port_number "a port number from 1 to 65535"
}

prompt_port_or_back() {
  prompt_validated_value_or_back "$1" "$2" "$3" "${4:-true}" "${5:-previous step}" is_port_number "a port number from 1 to 65535"
}

prompt_host() {
  prompt_validated_value "$1" "$2" "$3" "${4:-true}" is_host_name_or_ipv4 "a hostname, domain, localhost, or IPv4 address without a scheme, path, or port"
}

prompt_host_or_back() {
  prompt_validated_value_or_back "$1" "$2" "$3" "${4:-true}" "${5:-previous step}" is_host_name_or_ipv4 "a hostname, domain, localhost, or IPv4 address without a scheme, path, or port"
}

prompt_bind_host_or_back() {
  prompt_validated_value_or_back "$1" "$2" "$3" "${4:-true}" "${5:-previous step}" is_bind_host "an IPv4 bind address such as 127.0.0.1, 0.0.0.0, or the Breeze host IP"
}

prompt_origin() {
  prompt_validated_value "$1" "$2" "$3" "${4:-true}" is_http_origin "an http:// or https:// origin without a path, query string, or fragment"
}

prompt_origin_list() {
  prompt_validated_value "$1" "$2" "$3" "${4:-true}" validate_origin_list "comma-separated http:// or https:// origins without paths"
}

prompt_bool() {
  prompt_validated_value "$1" "$2" "$3" "${4:-true}" is_bool_value "true or false" normalize_bool_value
}

generate_secret() {
  case "$1" in
    hex32) openssl rand -hex 32 ;;
    base64_24) openssl rand -base64 24 | tr -d '\n' ;;
    base64_32) openssl rand -base64 32 | tr -d '\n' ;;
    base64_64) openssl rand -base64 64 | tr -d '\n' ;;
    *)
      fail "Unknown secret generator: $1"
      ;;
  esac
}

prompt_secret() {
  local key="$1"
  local label="$2"
  local generator="$3"
  local required="${4:-true}"
  local current default_action action value confirm

  current="$(get_env_value "${key}")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi

  if [[ "${SECRET_MODE}" == "auto" ]]; then
    if [[ -n "${current}" ]]; then
      printf '%s' "${current}"
      return
    fi
    if [[ "${required}" == "false" ]]; then
      set_env_value "${key}" ""
      printf '%s' ""
      return
    fi
    value="$(generate_secret "${generator}")"
    set_env_value "${key}" "${value}"
    printf '%s' "${value}"
    return
  fi

  if [[ -n "${current}" ]]; then
    if ask_yes_no "Keep existing value for ${key}?" "yes"; then
      printf '%s' "${current}"
      return
    fi
  fi

  default_action="g"
  while true; do
    if [[ "${required}" == "false" ]]; then
      if ! read_prompt action "${label} (${key}) action, g=generate/e=enter/blank=empty [g]: "; then
        fail "No input received for ${key}."
      fi
    else
      if ! read_prompt action "${label} (${key}) action, g=generate/e=enter [g]: "; then
        fail "No input received for ${key}."
      fi
    fi
    action="${action:-${default_action}}"

    case "${action}" in
      g|G|generate)
        value="$(generate_secret "${generator}")"
        break
        ;;
      e|E|enter)
        while true; do
          if ! read_secret_prompt value "Enter ${key}: "; then
            fail "No input received for ${key}."
          fi
          printf '\n'
          if [[ -z "${value}" && "${required}" == "false" ]]; then
            break
          fi
          if [[ -z "${value}" ]]; then
            warn "${key} is required."
            continue
          fi
          if ! read_secret_prompt confirm "Confirm ${key}: "; then
            fail "No confirmation received for ${key}."
          fi
          printf '\n'
          if [[ "${value}" == "${confirm}" ]]; then
            break
          fi
          warn "Values did not match. Try again."
        done
        break
        ;;
      blank|b|B|"")
        if [[ "${required}" == "false" ]]; then
          value=""
          break
        fi
        warn "${key} is required."
        ;;
      *)
        warn "Choose g, e, or blank."
        ;;
    esac
  done

  set_env_value "${key}" "${value}"
  printf '%s' "${value}"
}

urlencode() {
  local raw="$1"
  local length="${#raw}"
  local i char encoded=""

  for ((i = 0; i < length; i += 1)); do
    char="${raw:i:1}"
    case "${char}" in
      [a-zA-Z0-9.~_-]) encoded+="${char}" ;;
      *) printf -v encoded '%s%%%02X' "${encoded}" "'${char}" ;;
    esac
  done
  printf '%s' "${encoded}"
}

# The Compose and .env.example templates stay pinned to the selected Breeze
# release tag. This key is the official release-manifest trust anchor, not an
# app-version setting. Release .env.example files through v0.69.0 can leave it
# blank, so setup intentionally reads the current official trust root from main
# instead of failing older installs that still need agent update verification.
release_manifest_key_main_url() {
  local repo
  repo="$(github_repo_for_release_lookup)"
  printf 'https://raw.githubusercontent.com/%s/main/.env.example' "${repo}"
}

read_release_manifest_key_from_main() {
  local body key url

  url="$(release_manifest_key_main_url)"
  if ! body="$(curl -fsSL --connect-timeout 5 --max-time 15 "${url}")"; then
    return 1
  fi

  key="$(
    awk -F= '
      $1 == "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS" {
        sub(/^[^=]*=/, "")
        sub(/\r$/, "")
        print
        exit
      }
    ' <<< "${body}"
  )"
  key="$(strip_wrapping_quotes "${key}")"
  [[ -n "${key}" ]] || return 1
  [[ ! "${key}" =~ ^(__|example|change-me|changeme) ]] || return 1
  printf '%s' "${key}"
}

discover_release_manifest_key() {
  local key url

  url="$(release_manifest_key_main_url)"
  if key="$(read_release_manifest_key_from_main)"; then
    printf '%s' "${key}"
    return
  fi

  fail "Could not fetch RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS from ${url}; check network access and rerun setup."
}

configure_release_manifest_trust_root() {
  local current key

  current="$(get_env_value "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS")"
  if looks_like_placeholder "${current}"; then
    current=""
  fi
  if [[ -n "${current}" ]]; then
    log "Using existing release manifest public key trust root."
    return
  fi

  key="$(discover_release_manifest_key)"
  set_env_value "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS" "${key}"
  log "Using official Breeze release manifest public key trust root."
}

github_repo_for_release_lookup() {
  local repo

  repo="${BREEZE_SETUP_GITHUB_REPO:-}"
  if [[ -n "${repo}" ]]; then
    printf '%s' "${repo}"
    return
  fi

  if [[ "${REMOTE_BASE}" =~ raw[.]githubusercontent[.]com/([^/]+)/([^/]+)/ ]]; then
    printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return
  fi

  printf '%s' "lanternops/breeze"
}

strip_release_version_prefix() {
  local version="$1"
  version="${version#refs/tags/}"
  version="${version#v}"
  printf '%s' "${version}"
}

template_ref_for_breeze_version() {
  local version="$1"
  version="${version#v}"
  printf 'v%s' "${version}"
}

resolve_template_remote_base() {
  local repo ref

  if [[ -n "${REMOTE_BASE_OVERRIDE}" ]]; then
    REMOTE_BASE="${REMOTE_BASE_OVERRIDE%/}"
    warn "Using BREEZE_SETUP_REMOTE_BASE override for templates: ${REMOTE_BASE}"
    return
  fi

  [[ -n "${SELECTED_BREEZE_VERSION}" ]] || fail "Select BREEZE_VERSION before downloading templates."

  repo="$(github_repo_for_release_lookup)"
  ref="$(template_ref_for_breeze_version "${SELECTED_BREEZE_VERSION}")"
  REMOTE_BASE="https://raw.githubusercontent.com/${repo}/${ref}"
  log "Template downloads are pinned to Breeze release tag ${ref}."
}

fetch_latest_github_release_version() {
  local repo api_url body tag

  repo="$(github_repo_for_release_lookup)"
  api_url="${BREEZE_SETUP_GITHUB_API:-https://api.github.com}"

  if body="$(curl -fsSL --connect-timeout 5 --max-time 15 "${api_url}/repos/${repo}/releases/latest" 2>/dev/null)"; then
    tag="$(awk -F'"' '/"tag_name"[[:space:]]*:/ { print $4; exit }' <<< "${body}")"
    if [[ -n "${tag}" ]]; then
      strip_release_version_prefix "${tag}"
      return 0
    fi
  fi

  if body="$(curl -fsSL --connect-timeout 5 --max-time 15 "${api_url}/repos/${repo}/tags?per_page=1" 2>/dev/null)"; then
    tag="$(awk -F'"' '/"name"[[:space:]]*:/ { print $4; exit }' <<< "${body}")"
    if [[ -n "${tag}" ]]; then
      strip_release_version_prefix "${tag}"
      return 0
    fi
  fi

  return 1
}

select_breeze_version() {
  local current latest default_value answer

  if [[ -n "${SELECTED_BREEZE_VERSION}" ]]; then
    return
  fi

  section "Breeze Version"

  current=""
  if [[ -f "${ENV_FILE}" ]]; then
    current="$(get_env_value "BREEZE_VERSION")"
    if looks_like_placeholder "${current}"; then
      current=""
    fi
  fi

  if latest="$(fetch_latest_github_release_version)"; then
    default_value="${latest}"
    log "Latest Breeze release available on GitHub: ${latest}"
    log "Press Enter to install the latest release, or type a different version/tag."
  else
    default_value="${current}"
    warn "Could not fetch the latest Breeze release from GitHub."
    if [[ -n "${default_value}" ]]; then
      log "Press Enter to keep ${default_value}, or type the Breeze version/tag to install."
    else
      log "Type the Breeze version/tag to install."
    fi
  fi

  if [[ "${YES_MODE}" == "true" ]]; then
    if [[ -n "${default_value}" ]]; then
      answer="${default_value#v}"
      SELECTED_BREEZE_VERSION="${answer}"
      log "Selected Breeze version: ${answer}"
      return
    fi
    fail "BREEZE_VERSION requires a value; rerun without --yes or prefill it in ${ENV_FILE}."
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if ! read_prompt answer "Breeze version to install [${default_value}]: "; then
        fail "No input received for BREEZE_VERSION."
      fi
      answer="${answer:-${default_value}}"
    else
      if ! read_prompt answer "Breeze version to install: "; then
        fail "No input received for BREEZE_VERSION."
      fi
    fi

    if [[ -n "${answer}" ]]; then
      answer="${answer#v}"
      SELECTED_BREEZE_VERSION="${answer}"
      log "Selected Breeze version: ${answer}"
      return
    fi
    warn "BREEZE_VERSION is required."
  done
}

prompt_breeze_version() {
  select_breeze_version
  set_env_value "BREEZE_VERSION" "${SELECTED_BREEZE_VERSION}"
  log "Using Breeze version: ${SELECTED_BREEZE_VERSION}"
}

apply_reverse_proxy_env() {
  case "${REVERSE_PROXY_MODE}" in
    caddy)
      set_env_value "FORCE_HTTPS" "true"
      # The bundled Caddy is the API's only trusted proxy peer and is pinned at BREEZE_CADDY_IP
      # (172.31.0.10) so the API can derive REAL client IPs from Caddy's forwarded
      # headers out of the box. This MUST stay true: false makes the API attribute
      # every request to Caddy's container IP, collapsing per-IP rate limiting,
      # partner/admin IP allowlists, and audit IP attribution (SR2-16; locked by
      # apps/api/src/config/proxyTrustCompose.test.ts). Leaving TRUSTED_PROXY_CIDRS
      # empty lets compose re-default it to ${BREEZE_CADDY_IP:-172.31.0.10}/32.
      set_env_value "TRUST_PROXY_HEADERS" "true"
      set_env_value "TRUSTED_PROXY_CIDRS" ""
      set_env_value "CADDY_TRUSTED_PROXIES" "127.0.0.1/32 ::1/128"
      set_env_value "CADDY_CLIENT_IP_HEADERS" "CF-Connecting-IP X-Forwarded-For"
      set_env_value "BREEZE_EXTERNAL_PROXY" ""
      set_env_value "BREEZE_PROXY_TARGET_HOST" ""
      set_env_value "BREEZE_PROXY_BIND_HOST" ""
      set_env_value "BREEZE_API_HOST_PORT" ""
      set_env_value "BREEZE_WEB_HOST_PORT" ""
      set_env_value "BREEZE_EXTERNAL_PROXY_CIDRS" ""
      ;;
    npm|custom)
      set_env_value "FORCE_HTTPS" "true"
      set_env_value "TRUST_PROXY_HEADERS" "true"
      set_env_value "TRUSTED_PROXY_CIDRS" "${REVERSE_PROXY_EXTERNAL_CIDRS}"
      set_env_value "CADDY_TRUSTED_PROXIES" ""
      set_env_value "CADDY_CLIENT_IP_HEADERS" ""
      set_env_value "BREEZE_EXTERNAL_PROXY" "${REVERSE_PROXY_LABEL}"
      set_env_value "BREEZE_PROXY_TARGET_HOST" "${PROXY_TARGET_HOST}"
      set_env_value "BREEZE_PROXY_BIND_HOST" "${PROXY_BIND_HOST}"
      set_env_value "BREEZE_API_HOST_PORT" "${API_HOST_PORT}"
      set_env_value "BREEZE_WEB_HOST_PORT" "${WEB_HOST_PORT}"
      set_env_value "BREEZE_EXTERNAL_PROXY_CIDRS" "${REVERSE_PROXY_EXTERNAL_CIDRS}"
      ;;
    *)
      fail "Unknown reverse proxy mode: ${REVERSE_PROXY_MODE}"
      ;;
  esac
}

configure_core_env() {
  section "Required Settings"

  local domain acme_email app_url dashboard_url public_api_url
  local postgres_user postgres_db postgres_port postgres_password postgres_password_url
  local redis_password redis_password_url app_key mfa_key

  subsection "Public URLs"
  domain="$(prompt_host "BREEZE_DOMAIN" "Public domain, or localhost for local testing" "localhost" true)"

  if [[ "${domain}" == "localhost" ]]; then
    acme_email="admin@example.com"
  else
    acme_email="admin@${domain}"
  fi
  acme_email="$(prompt_value "ACME_EMAIL" "Email for certificate registration notices" "${acme_email}" true)"

  app_url="$(prompt_origin "PUBLIC_APP_URL" "Public app URL" "https://${domain}" true)"
  dashboard_url="$(prompt_origin "DASHBOARD_URL" "Dashboard URL" "${app_url}" true)"
  set_env_value "DASHBOARD_URL" "${dashboard_url}"
  public_api_url="$(prompt_origin "PUBLIC_API_URL" "Public API URL used by installers and links" "${app_url}" true)"
  set_env_value "API_URL" "${public_api_url}"
  prompt_origin_list "CORS_ALLOWED_ORIGINS" "Allowed browser origins" "${app_url}" true >/dev/null

  set_env_value "NODE_ENV" "production"
  set_env_value "IS_HOSTED" "false"
  apply_reverse_proxy_env
  if [[ "${REVERSE_PROXY_MODE}" != "caddy" ]]; then
    write_reverse_proxy_guide "${REVERSE_PROXY_LABEL}" "${domain}"
    log "Generated ${PROXY_GUIDE_FILE}."
  fi

  subsection "Registration"
  if ask_yes_no "Enable public self-registration?" "no"; then
    set_env_value "ENABLE_REGISTRATION" "true"
    set_env_value "PUBLIC_ENABLE_REGISTRATION" "true"
  else
    set_env_value "ENABLE_REGISTRATION" "false"
    set_env_value "PUBLIC_ENABLE_REGISTRATION" "false"
  fi

  prompt_breeze_version
  log "Using Docker image refs from ${ENV_FILE}; defaults track BREEZE_VERSION. Edit .env later only if you need digest-pinned or custom images."

  configure_release_manifest_trust_root

  section "Database And Redis"
  subsection "Postgres"
  postgres_user="$(prompt_validated_value "POSTGRES_USER" "Postgres admin user" "breeze" true is_postgres_identifier "a Postgres identifier: letter/underscore then letters, digits, or underscores (max 63)")"
  postgres_db="$(prompt_validated_value "POSTGRES_DB" "Postgres database name" "breeze" true is_postgres_identifier "a Postgres identifier: letter/underscore then letters, digits, or underscores (max 63)")"
  postgres_port="$(prompt_port "POSTGRES_PORT" "Host Postgres port for local tooling" "5432" true)"
  postgres_password="$(prompt_secret "POSTGRES_PASSWORD" "Postgres password" "hex32" true)"
  postgres_password_url="$(urlencode "${postgres_password}")"
  # DATABASE_URL here is a HOST-side value (localhost:${postgres_port}) for local
  # tooling like `pnpm db:studio`/`db:check-drift`. The root docker-compose.yml
  # ignores it and rebuilds DATABASE_URL as ...@postgres:5432 inside the API
  # container from POSTGRES_USER/PASSWORD/DB.
  set_env_value "DATABASE_URL" "postgresql://${postgres_user}:${postgres_password_url}@localhost:${postgres_port}/${postgres_db}"
  # DATABASE_URL_APP MUST be left empty for the bundled Compose: unlike
  # DATABASE_URL, compose passes DATABASE_URL_APP straight through to the API
  # container (`${DATABASE_URL_APP:-}`), so a localhost value would make the
  # unprivileged request pool dial 127.0.0.1 inside the container and fail with
  # ECONNREFUSED at seed/startup. Empty makes the API derive the breeze_app URL
  # from the container's ...@postgres DATABASE_URL using POSTGRES_PASSWORD
  # (see resolveRequestDatabaseConfig / the compose DATABASE_URL_APP comment).
  # Multi-host/HA deployments that need an explicit request-pool URL set it in
  # .env by hand after setup.
  set_env_value "DATABASE_URL_APP" ""
  set_env_value "BREEZE_APP_DB_PASSWORD" ""

  subsection "Redis"
  redis_password="$(prompt_secret "REDIS_PASSWORD" "Redis password" "hex32" true)"
  redis_password_url="$(urlencode "${redis_password}")"
  set_env_value "REDIS_URL" "redis://:${redis_password_url}@localhost:6379"
  set_env_value "REDIS_PORT" "6379"

  section "Application Secrets"
  subsection "Required Runtime Secrets"
  prompt_secret "JWT_SECRET" "JWT signing secret" "base64_64" true >/dev/null
  prompt_secret "AGENT_ENROLLMENT_SECRET" "Agent enrollment secret" "hex32" true >/dev/null
  app_key="$(prompt_secret "APP_ENCRYPTION_KEY" "Application encryption key" "hex32" true)"
  mfa_key="$(prompt_secret "MFA_ENCRYPTION_KEY" "MFA encryption key" "hex32" true)"
  while [[ "${app_key}" == "${mfa_key}" ]]; do
    warn "MFA_ENCRYPTION_KEY must not reuse APP_ENCRYPTION_KEY."
    mfa_key="$(generate_secret hex32)"
    set_env_value "MFA_ENCRYPTION_KEY" "${mfa_key}"
  done
  prompt_secret "ENROLLMENT_KEY_PEPPER" "Enrollment key pepper" "base64_32" true >/dev/null
  prompt_secret "MFA_RECOVERY_CODE_PEPPER" "MFA recovery code pepper" "base64_32" true >/dev/null
  prompt_secret "PARTNER_API_CURSOR_SIGNING_KEY" "Partner API cursor signing key" "base64_32" true >/dev/null
  prompt_secret "SESSION_SECRET" "Session secret" "base64_64" true >/dev/null
  prompt_secret "METRICS_SCRAPE_TOKEN" "Metrics scrape token" "hex32" true >/dev/null
  prompt_secret "GRAFANA_ADMIN_PASSWORD" "Grafana admin password" "base64_24" true >/dev/null

  section "Bootstrap Admin"
  subsection "One-Time Admin Account"
  BOOTSTRAP_EMAIL="$(prompt_value "BREEZE_BOOTSTRAP_ADMIN_EMAIL" "Initial Partner Admin email" "" true)"
  BOOTSTRAP_NAME="$(prompt_value "BREEZE_BOOTSTRAP_ADMIN_NAME" "Initial Partner Admin display name" "Owner Admin" false)"
  BOOTSTRAP_PASSWORD="$(prompt_secret "BREEZE_BOOTSTRAP_ADMIN_PASSWORD" "One-time bootstrap admin password" "base64_32" true)"

  log ""
  log "${C_OK}Bootstrap admin values stored temporarily in ${ENV_FILE}.${C_RESET}"
  log "Setup will show the one-time password only if Breeze starts successfully and the API is healthy."

  set_env_value "EMAIL_FROM" "noreply@${domain}"
  set_env_value "SMTP_FROM" "noreply@${domain}"
  set_env_value "MAILGUN_FROM" "noreply@${domain}"
  set_env_value "TURN_REALM" "${domain}"
}

configure_optional_env() {
  local email_from mailgun_from provider s3_endpoint s3_region smtp_from turn_secret

  section "Optional Integrations"

  subsection "Transactional Email"
  if ask_yes_no "Configure transactional email provider now?" "no"; then
    log "Email provider options:"
    log "  resend"
    log "  smtp"
    log "  mailgun"
    log "  auto"
    while true; do
      if ! read_prompt provider "Email provider [auto]: "; then
        fail "No input received for email provider."
      fi
      provider="${provider:-auto}"
      case "${provider}" in
        resend|smtp|mailgun|auto) break ;;
        *) log "Choose resend, smtp, mailgun, or auto." ;;
      esac
    done
    set_env_value "EMAIL_PROVIDER" "${provider}"
    case "${provider}" in
      resend)
        prompt_secret "RESEND_API_KEY" "Resend API key" "base64_32" true >/dev/null
        email_from="$(get_env_value "EMAIL_FROM")"
        prompt_value "EMAIL_FROM" "From email address" "${email_from}" true >/dev/null
        ;;
      smtp)
        prompt_value "SMTP_HOST" "SMTP host" "" true >/dev/null
        prompt_port "SMTP_PORT" "SMTP port" "587" true >/dev/null
        prompt_value "SMTP_USER" "SMTP username" "" false >/dev/null
        prompt_secret "SMTP_PASS" "SMTP password" "base64_32" false >/dev/null
        smtp_from="$(get_env_value "SMTP_FROM")"
        prompt_value "SMTP_FROM" "SMTP from email address" "${smtp_from}" true >/dev/null
        prompt_bool "SMTP_SECURE" "Use SMTP TLS immediately (true/false)" "false" true >/dev/null
        ;;
      mailgun)
        prompt_secret "MAILGUN_API_KEY" "Mailgun API key" "base64_32" true >/dev/null
        prompt_value "MAILGUN_DOMAIN" "Mailgun domain" "" true >/dev/null
        mailgun_from="$(get_env_value "MAILGUN_FROM")"
        prompt_value "MAILGUN_FROM" "Mailgun from email address" "${mailgun_from}" true >/dev/null
        ;;
      auto)
        ;;
    esac
  else
    set_env_value "EMAIL_PROVIDER" "auto"
  fi

  subsection "Object Storage"
  if ask_yes_no "Configure S3-compatible object storage now?" "no"; then
    s3_endpoint="$(get_env_value "S3_ENDPOINT")"
    s3_region="$(get_env_value "S3_REGION")"
    prompt_value "S3_ENDPOINT" "S3 endpoint URL" "${s3_endpoint}" true >/dev/null
    prompt_value "S3_REGION" "S3 region" "${s3_region}" true >/dev/null
    prompt_value "S3_BUCKET" "S3 bucket" "" true >/dev/null
    prompt_value "S3_ACCESS_KEY" "S3 access key" "" true >/dev/null
    prompt_secret "S3_SECRET_KEY" "S3 secret key" "base64_32" true >/dev/null
  else
    set_env_value "S3_BUCKET" ""
    set_env_value "S3_ACCESS_KEY" ""
    set_env_value "S3_SECRET_KEY" ""
  fi

  subsection "TURN Relay"
  if ask_yes_no "Enable TURN relay for remote desktop across NAT/firewalls?" "no"; then
    set_env_value "COMPOSE_PROFILES" "turn"
    prompt_value "TURN_HOST" "TURN server public IP address" "" true >/dev/null
    prompt_port "TURN_PORT" "TURN port" "3478" true >/dev/null
    prompt_secret "TURN_SECRET" "TURN shared secret" "hex32" true >/dev/null
  else
    set_env_value "COMPOSE_PROFILES" ""
    set_env_value "TURN_HOST" ""
    turn_secret="$(get_env_value "TURN_SECRET")"
    if looks_like_placeholder "${turn_secret}"; then
      turn_secret="$(generate_secret hex32)"
      set_env_value "TURN_SECRET" "${turn_secret}"
    fi
  fi
}

validate_compose_config() {
  section "Compose Validation"
  compose config >/dev/null
  log "${C_OK}Compose configuration rendered successfully.${C_RESET}"
}

print_npm_advanced_tab_snippet() {
  cat <<EOF
NPM Advanced tab copy/paste:

$(print_npm_advanced_tab_config)
EOF
}

print_reverse_proxy_console_summary() {
  local app_url public_host

  [[ "${REVERSE_PROXY_MODE}" != "caddy" ]] || return 0

  app_url="$(get_env_value "PUBLIC_APP_URL")"
  public_host="${app_url#http://}"
  public_host="${public_host#https://}"

  section "Reverse Proxy Setup"
  log "Set up ${REVERSE_PROXY_LABEL} before exposing Breeze publicly."
  log "Public app URL: ${app_url}"
  log "API upstream: http://${PROXY_TARGET_HOST}:${API_HOST_PORT}"
  log "Web upstream: http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT}"
  log "Docker bind address: ${PROXY_BIND_HOST}"
  log "Trusted proxy source CIDR(s): ${REVERSE_PROXY_EXTERNAL_CIDRS}"
  log "Full setup guide: ${PROXY_GUIDE_FILE}"
  log ""

  case "${REVERSE_PROXY_MODE}" in
    npm)
      log "Nginx Proxy Manager quick setup:"
      log "  - Create one Proxy Host for ${public_host}."
      log "  - Details tab forwards to ${PROXY_TARGET_HOST}:${WEB_HOST_PORT}."
      log "  - Enable Websockets Support, Force SSL, HTTP/2, and disable asset caching."
      log "  - Paste the generated block into the Advanced tab; it includes the API/Web path routing."
      log ""
      print_npm_advanced_tab_snippet
      ;;
    custom)
      log "Other reverse proxy quick setup:"
      log "  - Route API/OAuth/agent paths to http://${PROXY_TARGET_HOST}:${API_HOST_PORT}."
      log "  - Route dashboard and web exception paths to http://${PROXY_TARGET_HOST}:${WEB_HOST_PORT}."
      log "  - Enable WebSocket upgrades, disable buffering for streaming paths, and use long read/send timeouts."
      ;;
    *)
      ;;
  esac

  log ""
  log "Routing reminder:"
  log "  - API paths: /api, /s, /health, /ready, /metrics, /i, /oauth, /.well-known/*, /activate"
  log "  - Web exceptions: /oauth/consent, /activate/complete"
  if [[ "${REVERSE_PROXY_MODE}" == "custom" ]]; then
    log "  - Custom proxies can also route /activate/* with a status query to Web."
  fi
}

print_generated_config_summary() {
  log ""
  log "${C_OK}Generated and validated Breeze setup files.${C_RESET}"
  log "Environment file: ${ENV_FILE}"
  log "Compose file: ${COMPOSE_FILE}"
  log "Storage mode: ${STORAGE_MODE_LABEL}"
  if dry_run_enabled; then
    log "Dry run: Docker and systemd changes were skipped"
  fi
  if [[ "${REVERSE_PROXY_MODE}" != "caddy" ]]; then
    log "Compose file mode: external reverse proxy, packaged Caddy removed"
    log "External proxy guide: ${PROXY_GUIDE_FILE}"
  fi
  print_reverse_proxy_console_summary
}

print_manual_start_commands() {
  log ""
  log "Run this when ready:"
  log "  $(compose_command_for_display) pull"
  log "  $(compose_command_for_display) up -d"
}

print_bootstrap_cleanup_reminder() {
  warn "Bootstrap admin values are still stored in ${ENV_FILE}."
  warn "After the first project start and admin account setup, clear BREEZE_BOOTSTRAP_ADMIN_EMAIL, BREEZE_BOOTSTRAP_ADMIN_PASSWORD, and BREEZE_BOOTSTRAP_ADMIN_NAME from ${ENV_FILE}."
  warn "Then recreate the API container so the one-time bootstrap values are removed from the running environment."
}

print_bootstrap_credentials_for_signin() {
  log "Sign in with the bootstrap admin credentials:"
  log "  Email: ${BOOTSTRAP_EMAIL}"
  log "  Password: ${BOOTSTRAP_PASSWORD}"
  if [[ -n "${BOOTSTRAP_NAME}" ]]; then
    log "  Name: ${BOOTSTRAP_NAME}"
  fi
  warn "This temporary password is visible in terminal scrollback and any captured setup logs until bootstrap cleanup completes."
  warn "Keep this terminal private, sign in once, then let setup remove BREEZE_BOOTSTRAP_ADMIN_* from ${ENV_FILE}."
}

confirm_start_after_generation() {
  local choice

  print_generated_config_summary

  if [[ "${YES_MODE}" == "true" ]]; then
    return 0
  fi

  section "Start Or Quit"
  while true; do
    log "Choose the next step:"
    log "  1) Pull images, start Breeze now, and continue guided admin setup"
    log "  2) Quit now with only the generated files"
    if ! read_prompt choice "Next step [1]: "; then
      fail "No input received for start decision."
    fi
    choice="${choice:-1}"
    case "${choice}" in
      1|s|S|start|continue|c|C)
        return 0
        ;;
      2|q|Q|quit|exit)
        print_manual_start_commands
        print_bootstrap_cleanup_reminder
        if ask_yes_no "Quit setup now? Choose no to go back and start Breeze from this script." "yes"; then
          return 1
        fi
        ;;
      *)
        log "Choose 1 to start or 2 to quit."
        ;;
    esac
  done
}

compose_file_args() {
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    printf '%s\n' "-f"
    printf '%s\n' "${file}"
  done
}

compose() {
  local args=()
  local arg
  while IFS= read -r arg; do
    args+=("${arg}")
  done < <(compose_file_args)

  if dry_run_enabled; then
    case "${1:-}" in
      pull|up|down|stop|restart|rm)
        dry_run_log "Would run: $(compose_command_for_display) $*"
        return 0
        ;;
    esac
  fi

  docker compose "${args[@]}" --env-file "${ENV_FILE}" "$@"
}

compose_command_for_display() {
  local cmd="docker compose"
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    cmd+=" -f ${file}"
  done
  cmd+=" --env-file ${ENV_FILE}"
  printf '%s' "${cmd}"
}

print_api_logs_for_timeout() {
  log "Recent breeze-api logs:"
  if ! docker logs --tail 80 breeze-api; then
    warn "Could not read breeze-api logs. Inspect manually with: docker logs --tail 80 breeze-api"
  fi
}

wait_for_api_health() {
  local status

  if dry_run_enabled; then
    dry_run_log "Skipping API health wait."
    return 0
  fi

  log "Waiting for breeze-api container health..."
  for _ in $(seq 1 90); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' breeze-api 2>/dev/null || true)"
    if [[ "${status}" == "healthy" ]]; then
      log "${C_OK}API is healthy.${C_RESET}"
      return 0
    fi
    if [[ "${status}" == "unhealthy" ]]; then
      warn "API reports unhealthy. Continuing to wait; inspect with: docker logs breeze-api"
    fi
    sleep 2
  done
  warn "API did not report healthy within the wait window."
  print_api_logs_for_timeout
  return 1
}

handle_bootstrap_cleanup_prewrite_failure() {
  local backup="$1"

  if rm -f "${backup}"; then
    log "Removed temporary backup ${backup}; ${ENV_FILE} was left unchanged."
  else
    warn "Could not remove temporary backup ${backup}; it may contain bootstrap admin credentials."
  fi
  warn "Edit ${ENV_FILE} manually and clear BREEZE_BOOTSTRAP_ADMIN_EMAIL, BREEZE_BOOTSTRAP_ADMIN_PASSWORD, and BREEZE_BOOTSTRAP_ADMIN_NAME after first login."
}

scrub_bootstrap_env() {
  local backup tmp

  section "Bootstrap Cleanup"

  backup="$(backup_path_for "${ENV_FILE}")"
  if ! cp "${ENV_FILE}" "${backup}"; then
    fail "Failed to back up ${ENV_FILE} before bootstrap cleanup."
  fi
  # Must be guarded: scrub_bootstrap_env runs under `if start_stack; then`, which
  # disables errexit, so a bare chmod failure would leave this secrets-bearing
  # backup world/group-readable while printing a "Backed up..." success line.
  if ! chmod 600 "${backup}"; then
    fail "Failed to secure permissions on ${backup}; it contains secrets. Remove it manually."
  fi
  log "Backed up ${ENV_FILE} to ${backup} before bootstrap cleanup."

  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  if ! write_bootstrap_scrubbed_env_file "${ENV_FILE}" "${tmp}"; then
    rm -f "${tmp}"
    handle_bootstrap_cleanup_prewrite_failure "${backup}"
    fail "Failed to create bootstrap cleanup candidate for ${ENV_FILE}."
  fi

  if ! validate_env_rewrite_candidate "${tmp}" "${ENV_FILE}" "bootstrap-scrub"; then
    rm -f "${tmp}"
    handle_bootstrap_cleanup_prewrite_failure "${backup}"
    fail "Bootstrap cleanup candidate failed integrity checks; existing ${ENV_FILE} was left unchanged."
  fi

  if ! mv "${tmp}" "${ENV_FILE}"; then
    rm -f "${tmp}"
    warn "Leaving backup at ${backup}; it may contain bootstrap admin credentials."
    fail "Failed to replace ${ENV_FILE} with verified bootstrap cleanup candidate."
  fi
  if ! chmod 600 "${ENV_FILE}"; then
    warn "Leaving backup at ${backup}; it may contain bootstrap admin credentials."
    fail "Failed to set secure permissions on ${ENV_FILE}."
  fi
  BOOTSTRAP_SCRUBBED="true"
  log "Removed bootstrap admin values from ${ENV_FILE}."

  if [[ "${STACK_STARTED}" == "true" ]]; then
    if ask_yes_no "Recreate the API container now so bootstrap values are removed from its environment?" "yes"; then
      if ! compose up -d api; then
        warn "Leaving backup at ${backup}; it may contain bootstrap admin credentials."
        fail "Failed to recreate the API container after bootstrap cleanup."
      fi
      if dry_run_enabled; then
        dry_run_log "Would recreate the API container without bootstrap env values."
      else
        log "${C_OK}API container updated without bootstrap env values.${C_RESET}"
      fi
    else
      warn "Bootstrap values are removed from ${ENV_FILE}, but the running API container may still have its old environment until it is recreated."
    fi
  fi

  if rm -f "${backup}"; then
    log "Removed temporary backup ${backup}."
  else
    warn "Could not remove temporary backup ${backup}; it may contain bootstrap admin credentials."
  fi
}

start_stack() {
  section "Start Breeze"

  if ! ask_yes_no "Pull Breeze and dependency images now?" "yes"; then
    log "Skipping docker compose pull."
  elif ! compose pull; then
    # Non-fatal: any images already present locally may still let `up` succeed.
    # But surface it — start_stack runs under `if start_stack; then`, which
    # disables set -e, so a swallowed failure would otherwise be invisible.
    warn "docker compose pull failed (network, registry, or auth). Will still try to start with images already present locally."
  fi

  if ! ask_yes_no "Start Breeze with docker compose up -d?" "yes"; then
    log "Skipping docker compose up -d."
    print_manual_start_commands
    print_bootstrap_cleanup_reminder
    return 1
  fi

  if ! compose up -d; then
    warn "docker compose up -d failed; the stack did not start."
    print_manual_start_commands
    print_bootstrap_cleanup_reminder
    return 1
  fi
  STACK_STARTED="true"
  if dry_run_enabled; then
    dry_run_log "Simulating a started stack so the guided admin and boot-start prompts can be reviewed."
  fi
  if ! wait_for_api_health; then
    warn "Skipping guided admin sign-in and bootstrap cleanup because the API did not become healthy."
    warn "Keep the bootstrap admin values in ${ENV_FILE} until you can sign in and finish first setup."
    warn "After fixing startup, rerun setup or manually clear BREEZE_BOOTSTRAP_ADMIN_* after first login."
    return 1
  fi

  local app_url
  app_url="$(get_env_value "PUBLIC_APP_URL")"

  section "Create Admin Account"
  log "Open: ${app_url}"
  print_bootstrap_credentials_for_signin
  log ""
  log "After signing in, finish the initial admin setup in Breeze."
  log "This script will then remove BREEZE_BOOTSTRAP_ADMIN_EMAIL, BREEZE_BOOTSTRAP_ADMIN_PASSWORD, and BREEZE_BOOTSTRAP_ADMIN_NAME from ${ENV_FILE}."

  if ask_yes_no "Have you signed in successfully and finished the initial setup?" "no"; then
    scrub_bootstrap_env
  else
    warn "Leaving bootstrap values in ${ENV_FILE} so you can complete first login."
    warn "Rerun this script after setup or manually clear BREEZE_BOOTSTRAP_ADMIN_* once the admin account is ready."
  fi
}

on_exit() {
  local exit_status=$?
  # Remove any leftover atomic-write temp files. Each writer mktemp's
  # "<file>.tmp.XXXXXX" and rm's/mv's it on its own success/handled-failure
  # paths, but a signal or a set -e abort between mktemp and that cleanup would
  # strand one — and the .env temps can hold secrets. Globs stay literal (and
  # rm -f no-ops) when nothing matches; each is guarded on a non-empty base.
  [[ -n "${ENV_FILE:-}" ]] && rm -f "${ENV_FILE}".tmp.* 2>/dev/null
  [[ -n "${COMPOSE_FILE:-}" ]] && rm -f "${COMPOSE_FILE}".tmp.* 2>/dev/null
  [[ -n "${PROXY_GUIDE_FILE:-}" ]] && rm -f "${PROXY_GUIDE_FILE}".tmp.* 2>/dev/null
  if [[ "${STACK_STARTED}" == "true" && "${BOOTSTRAP_SCRUBBED}" != "true" ]]; then
    warn "Bootstrap admin values may still be present in ${ENV_FILE}. Remove BREEZE_BOOTSTRAP_ADMIN_* after first login."
  fi
  return "${exit_status}"
}
trap on_exit EXIT

main() {
  section "Breeze Guided Setup"
  log "Working directory: ${WORK_DIR}"
  log "Environment file: ${ENV_FILE}"

  if [[ "${INSTALL_SYSTEMD_ONLY}" == "true" ]]; then
    install_systemd_only
    return
  fi

  check_prerequisites
  select_breeze_version
  resolve_template_remote_base
  prepare_templates
  prepare_env_file
  preserve_existing_compose_project_name
  materialize_env_from_example
  configure_setup_choices
  apply_proxy_compose_file
  ensure_packaged_caddy_assets
  apply_storage_compose_file
  check_existing_installation_conflicts
  check_proxy_port_conflicts
  configure_core_env
  configure_optional_env
  materialize_env_from_example
  validate_compose_config

  if [[ "${NO_UP}" == "true" ]]; then
    print_generated_config_summary
    print_manual_start_commands
    print_bootstrap_cleanup_reminder
    return
  fi

  if ! confirm_start_after_generation; then
    return
  fi

  if start_stack; then
    configure_boot_start
    log ""
    log "${C_OK}Guided setup complete.${C_RESET}"
  else
    log ""
    log "${C_OK}Generated setup files are ready.${C_RESET}"
  fi
}

main "$@"
