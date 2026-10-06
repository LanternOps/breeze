#!/usr/bin/env bash

# Behavioral guard: the systemd unit that guided-setup.sh installs must be a
# unit systemd actually accepts.
#
# Why this guard exists
# ---------------------
# The unit is generated from a heredoc, so nothing validated it until a
# self-hoster's `systemctl enable --now` failed at install time with
# "Unit breeze-rmm.service has a bad unit file setting." That shipped TWICE
# under #4201:
#   1. `Type=oneshot` + `Restart=on-failure` — a combination systemd rejects.
#   2. `WorkingDirectory='/home/breeze/breeze'` — the path was wrapped by
#      shell_quote(); systemd does not unquote WorkingDirectory= (unlike
#      ExecStart=), so the leading quote made the path non-absolute (-ENOEXEC).
# The first guard only grepped for case 1 and deliberately skipped
# systemd-analyze, so case 2 sailed through CI and reached the same customer.
#
# What this guard does
# --------------------
# 1. Static checks that run everywhere (macOS included): the known-bad shapes.
# 2. Renders the REAL unit + boot helper through the installer's own code path
#    (`guided-setup.sh --render-systemd-unit DIR`) and runs `systemd-analyze
#    verify` on it wherever systemd-analyze exists — every Linux CI runner.
#    That is the same parser systemd uses at `systemctl enable`, so any future
#    directive systemd rejects fails here, in the required Lint job, instead
#    of on a self-hoster's box.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP="${REPO_ROOT}/scripts/guided-setup.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

fail=0

# --- 1. Static checks on the heredoc ---------------------------------------
unit_text="$(awk '/^\[Unit\]$/,/^EOF$/' "${SETUP}")"

if [[ -z "${unit_text}" ]]; then
  echo "ERROR: could not locate the generated systemd unit heredoc in ${SETUP}" >&2
  exit 1
fi

if grep -q '^Type=oneshot' <<<"${unit_text}" && grep -Eq '^Restart=(always|on-failure|on-success|on-abort|on-watchdog)' <<<"${unit_text}"; then
  echo "ERROR: generated unit combines Type=oneshot with a Restart= value systemd rejects (\"bad unit file setting\", #4201)." >&2
  fail=1
fi

# WorkingDirectory= takes a raw path: systemd does not strip quotes, so a
# shell_quote()d value is a non-absolute path and the whole unit is rejected.
if grep -Eq '^WorkingDirectory=.*(shell_quote|bash_source_quote)' <<<"${unit_text}"; then
  echo "ERROR: generated unit quotes WorkingDirectory=; systemd does not unquote it and rejects the unit (\"bad unit file setting\", #4201)." >&2
  fail=1
fi

# --- 2. Render through the installer and verify with systemd itself ---------
# A work dir with a space and a % proves the path survives unquoted and that
# %-specifier escaping is applied (systemd expands % in unit paths).
WORK="${TMP_DIR}/breeze work%dir"
RENDER="${TMP_DIR}/render"
mkdir -p "${WORK}"

if ! BREEZE_SETUP_SYSTEMD_HELPER_FILE="${RENDER}/breeze-compose-boot.sh" \
  bash "${SETUP}" --work-dir "${WORK}" --render-systemd-unit "${RENDER}" >"${TMP_DIR}/render.log" 2>&1; then
  echo "ERROR: guided-setup.sh --render-systemd-unit failed:" >&2
  cat "${TMP_DIR}/render.log" >&2
  exit 1
fi

UNIT="${RENDER}/breeze-rmm.service"
HELPER="${RENDER}/breeze-compose-boot.sh"
[[ -f "${UNIT}" ]] || { echo "ERROR: ${UNIT} was not rendered" >&2; exit 1; }
[[ -x "${HELPER}" ]] || { echo "ERROR: ${HELPER} was not rendered executable" >&2; exit 1; }

if ! bash -n "${HELPER}"; then
  echo "ERROR: rendered boot helper has a bash syntax error" >&2
  fail=1
fi

# --- 3. service_exists must survive SIGPIPE under pipefail (#7960) ---------
# The helper runs under `set -euo pipefail`. If service_exists pipes
# `docker compose config --services` into `grep -q`, grep exits at the first
# match and the still-writing producer dies of SIGPIPE; pipefail turns that into
# a false "no such service", and caddy is never recreated after a reboot.
# Exercise the rendered function against a stub docker that keeps writing after
# the matching line, far past a pipe buffer, so the race is deterministic.
STUB_BIN="${TMP_DIR}/stub-bin"
mkdir -p "${STUB_BIN}"
STUB_CALLS="${TMP_DIR}/stub-docker-calls"
cat >"${STUB_BIN}/docker" <<'STUB'
#!/usr/bin/env bash
# Answer only the exact query service_exists must make:
#   docker compose [-f FILE]... --env-file FILE config --services
printf '%s\n' "$*" >>"${STUB_CALLS:?}"
[[ "${STUB_FAIL:-0}" == 1 ]] && { echo "stub docker: injected failure" >&2; exit 1; }
[[ "${1:-}" == compose ]] || { echo "stub docker: unexpected subcommand: $*" >&2; exit 2; }
shift
saw_file=0
saw_env=0
while [[ $# -gt 2 ]]; do
  case "$1" in
    -f) [[ $# -gt 3 ]] || break; saw_file=1; shift 2 ;;
    --env-file) [[ $# -gt 3 ]] || break; saw_env=1; shift 2 ;;
    *) echo "stub docker: unexpected compose argument: $1" >&2; exit 2 ;;
  esac
done
[[ "${saw_file}" -eq 1 && "${saw_env}" -eq 1 && "$*" == "config --services" ]] \
  || { echo "stub docker: unexpected compose query: $*" >&2; exit 2; }
# STUB_SERVICE is a per-run name the function cannot know in advance; it is
# listed early (so grep matches before the producer finishes) and caddy last.
printf 'api\n%s\n' "${STUB_SERVICE:?}"
i=0
while [ "${i}" -lt 20000 ]; do printf 'coturn-%s\n' "${i}"; i=$((i + 1)); done
printf 'caddy\n'
STUB
chmod +x "${STUB_BIN}/docker"

service_exists_fn="$(awk '/^service_exists\(\) \{$/,/^\}$/' "${HELPER}")"
# The helper's own compose=( ... ) array, so the stub sees the real -f/--env-file arguments.
compose_decl="$(awk '/^compose=\($/,/^\)$/' "${HELPER}")"
if [[ -z "${service_exists_fn}" || -z "${compose_decl}" ]]; then
  echo "ERROR: rendered boot helper has no service_exists() function or compose=( ) array" >&2
  fail=1
else
  probe() {
    : >"${STUB_CALLS}"
    STUB_SERVICE="${STUB_SERVICE}" STUB_CALLS="${STUB_CALLS}" PATH="${STUB_BIN}:${PATH}" \
      bash -c 'set -euo pipefail; eval "$1"; eval "$2"; service_exists "$3"' _ "${compose_decl}" "${service_exists_fn}" "$1"
  }
  STUB_SERVICE="probe-svc-${RANDOM}${RANDOM}"
  if ! probe "${STUB_SERVICE}"; then
    echo "ERROR: service_exists returned false for a service listed early in compose output (SIGPIPE under pipefail, #7960)." >&2
    fail=1
  fi
  if ! probe caddy; then
    echo "ERROR: service_exists caddy returned false while the service list contains caddy." >&2
    fail=1
  fi
  if [[ ! -s "${STUB_CALLS}" ]]; then
    echo "ERROR: service_exists never queried docker compose config --services." >&2
    fail=1
  fi
  if probe not-a-service; then
    echo "ERROR: service_exists returned true for a service that is not in the list." >&2
    fail=1
  fi
  # A failed compose query must stop the helper, not read as "absent": the
  # helper calls service_exists inside an if, where set -e does not apply.
  query_failure_out="$(STUB_FAIL=1 STUB_SERVICE=unused STUB_CALLS="${STUB_CALLS}" PATH="${STUB_BIN}:${PATH}" \
    bash -c 'set -euo pipefail; eval "$1"; eval "$2"; if service_exists caddy; then :; fi; echo continued' \
    _ "${compose_decl}" "${service_exists_fn}" 2>/dev/null || true)"
  if [[ "${query_failure_out}" == *continued* ]]; then
    echo "ERROR: service_exists treated a failed docker compose query as a missing service; the helper kept going." >&2
    fail=1
  fi
fi

# The rendered WorkingDirectory must be the raw absolute path (specifier-escaped).
expected_wd="WorkingDirectory=${WORK//%/%%}"
if ! grep -qxF "${expected_wd}" "${UNIT}"; then
  echo "ERROR: rendered unit does not contain the raw work dir path:" >&2
  echo "  expected: ${expected_wd}" >&2
  echo "  got:      $(grep '^WorkingDirectory=' "${UNIT}" || echo '<missing>')" >&2
  fail=1
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  # --recursive-errors=no (systemd >= 250): a missing docker.service on the
  # verifying host is not a defect in OUR unit. Older systemd lacks the flag;
  # fall back to the plain invocation there.
  if systemd-analyze verify --help 2>/dev/null | grep -q -- '--recursive-errors'; then
    verify_cmd=(systemd-analyze verify --recursive-errors=no "${UNIT}")
  else
    verify_cmd=(systemd-analyze verify "${UNIT}")
  fi
  if ! "${verify_cmd[@]}" >"${TMP_DIR}/verify.log" 2>&1; then
    echo "ERROR: systemd-analyze verify rejected the generated unit:" >&2
    cat "${TMP_DIR}/verify.log" >&2
    fail=1
  elif grep -Eiq 'bad unit file setting|fatal error|not absolute|ignoring' "${TMP_DIR}/verify.log"; then
    # verify can exit 0 while still logging a directive it dropped ("...,
    # ignoring"); a dropped directive is a broken unit for us.
    echo "ERROR: systemd-analyze verify reported a rejected directive:" >&2
    cat "${TMP_DIR}/verify.log" >&2
    fail=1
  fi
  verified="systemd-analyze verify ($(systemd-analyze --version | head -1))"
else
  verified="static checks only (systemd-analyze not available on this host)"
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi
echo "guided-setup systemd unit: OK — ${verified}"
