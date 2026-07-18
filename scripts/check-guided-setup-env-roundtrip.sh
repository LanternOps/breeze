#!/usr/bin/env bash

# Behavioral regression guard for the guided installer's .env value encoding.
#
# format_env_value / strip_wrapping_quotes / set_env_value / get_env_value must
# round-trip arbitrary values through the generated .env, including ones with
# characters that previously aborted the installer mid-run:
#   - a single quote  (O'Brien)         -> double-quoted, compose-literal
#   - a space + hash  (pass #1)         -> not mistaken for an inline comment
#   - a backslash     (back\slash)      -> not mangled by awk -v
#   - a dollar sign   (it's a $5)       -> not interpolated by compose
#   - a single quote + \ " ` $ together (a'b\c"d`e$f) -> forces the double-quote
#     branch of format_env_value AND its escape reversal in strip_wrapping_quotes,
#     which the single-quote-only cases above never reach
# All were fail-closed (they aborted setup), but a real admin display name or a
# manually-entered password can trigger them. This guard proves the round-trip.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

FUNCTIONS_FILE="${TMP_DIR}/guided-setup-functions.sh"
VALUES_FILE="${TMP_DIR}/values.txt"
RESULT_FILE="${TMP_DIR}/result.txt"

sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"

# Test values, one per line. A quoted heredoc is NOT parsed by the shell, so
# every character (', ", `, $, \, #, space) is literal data — the values under
# test never pass through shell quoting on their way in.
cat > "${VALUES_FILE}" <<'VALUES'
O'Brien
pass #1
sp ace
d$llar
quo"te
back\slash
plainHex123
a+b/c=d
we'ird #x
a$b`c\d"e
it's a $5 #deal
a'b\c"d`e$f
VALUES

# Assertions run in a subshell so we can source the installer's functions and
# then relax the `set -euo pipefail` / EXIT trap / exiting `fail` it installs at
# top level, without affecting this script's own strict mode. Results go to a
# file (not command substitution) to keep the adversarial values away from any
# nested parsing.
(
  # Sourcing the installer runs its top-level code, which derives ENV_FILE from
  # WORK_DIR="${BREEZE_SETUP_DIR:-$(pwd)}". Point that at the sandbox BEFORE the
  # source so ENV_FILE lands in TMP_DIR — otherwise the guard would truncate the
  # developer's real ./.env on every iteration. Re-assert ENV_FILE afterward as
  # belt-and-suspenders in case that derivation logic ever changes.
  export BREEZE_SETUP_DIR="${TMP_DIR}"
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}" >/dev/null 2>&1
  ENV_FILE="${TMP_DIR}/.env"
  trap - EXIT
  set +e +u +o pipefail
  warn() { :; }
  log() { :; }
  # Override the installer's exiting fail so a single failed case reports instead
  # of killing the whole harness.
  fail() { printf 'fail:%s\n' "$*" >&2; return 1; }

  fails=0
  while IFS= read -r v; do
    printf 'EXISTING=keepme\nOTHER=42\n' > "${ENV_FILE}"
    set_env_value "TESTKEY" "${v}" >/dev/null 2>&1
    got="$(get_env_value "TESTKEY" 2>/dev/null)"
    keep="$(get_env_value "EXISTING" 2>/dev/null)"
    if [[ "${got}" != "${v}" ]]; then
      printf 'MISMATCH: input=[%s] read_back=[%s]\n' "${v}" "${got}"
      fails=$((fails + 1))
    fi
    if [[ "${keep}" != "keepme" ]]; then
      printf 'CLOBBERED an unrelated key while writing [%s]\n' "${v}"
      fails=$((fails + 1))
    fi
  done < "${VALUES_FILE}"

  # Updating an existing key twice must stay idempotent (one line, right value).
  printf 'TESTKEY=old\n' > "${ENV_FILE}"
  set_env_value "TESTKEY" "O'Reilly #7" >/dev/null 2>&1
  set_env_value "TESTKEY" "O'Reilly #7" >/dev/null 2>&1
  count="$(grep -c '^TESTKEY=' "${ENV_FILE}")"
  got="$(get_env_value "TESTKEY" 2>/dev/null)"
  if [[ "${count}" != "1" || "${got}" != "O'Reilly #7" ]]; then
    printf 'IN-PLACE UPDATE not idempotent: count=%s read=[%s]\n' "${count}" "${got}"
    fails=$((fails + 1))
  fi

  printf 'FAILS=%s\n' "${fails}"
) > "${RESULT_FILE}" 2>&1

if ! grep -q '^FAILS=0$' "${RESULT_FILE}"; then
  printf 'check-guided-setup-env-roundtrip: .env value round-trip FAILED:\n' >&2
  cat "${RESULT_FILE}" >&2
  exit 1
fi

printf 'guided setup .env value round-trip guard passed\n'
