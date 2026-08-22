#!/usr/bin/env bash

# Behavioral guard: every placeholder secret shipped in .env.example must be
# recognised by the guided installer's looks_like_placeholder().
#
# Why this guard exists
# ---------------------
# prompt_secret() keeps whatever value is already in .env unless
# looks_like_placeholder() says it is a placeholder, in which case it generates a
# real secret. That predicate is a substring allowlist of the exact wordings used
# in .env.example — so it is only correct as long as nobody introduces a new
# wording, and it fails SILENTLY when someone does: `--yes`/auto mode copies the
# placeholder text straight into .env and the API then refuses to boot.
#
# PARTNER_API_CURSOR_SIGNING_KEY shipped exactly that way. Every other secret in
# .env.example used `generate-a-random-...` or `...-change-in-production`, both
# matched; it alone used `replace-with-base64-encoded-32-byte-random-key`, which
# was not. Self-hosters running the guided installer got a .env whose cursor
# signing key was the literal placeholder string, and the API refused to start
# (validate.ts requires canonical base64 decoding to >= 32 bytes in production).
#
# So: derive the expectation from .env.example rather than from a hand-kept list.
# Any secret-shaped placeholder added there in a new wording fails here, in the
# required Lint job, instead of in someone's install.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

[[ -f "${ENV_EXAMPLE}" ]] || {
  echo "FAIL: ${ENV_EXAMPLE} not found" >&2
  exit 1
}

FUNCTIONS_FILE="${TMP_DIR}/guided-setup-functions.sh"
CANDIDATES_FILE="${TMP_DIR}/candidates.txt"

sed '/^main "\$@"$/d' "${REPO_ROOT}/scripts/guided-setup.sh" > "${FUNCTIONS_FILE}"

# Candidate placeholders: non-empty assignments in .env.example whose VALUE looks
# like prose-instructions-to-a-human rather than a real default. Real defaults
# (ports, booleans, durations, URLs, image refs, version pins) never match these
# markers, so this stays quiet unless somebody genuinely ships a new placeholder
# wording. Matching is on the value only — a key named REPLACE_ME with a real
# default is not a placeholder.
grep -E '^[A-Za-z_][A-Za-z0-9_]*=.+' "${ENV_EXAMPLE}" \
  | grep -iE '=[^=]*(replace[-_ ]?with|change[-_ ]?me|change[-_ ]?in[-_ ]production|generate[-_ ]a[-_ ]random|your-super-secret|your-enrollment-secret|placeholder|__generate_me__|secure_password)' \
  > "${CANDIDATES_FILE}" || true

if [[ ! -s "${CANDIDATES_FILE}" ]]; then
  echo "FAIL: found no placeholder-shaped values in .env.example." >&2
  echo "Either every placeholder was replaced with a real default (then delete this guard)," >&2
  echo "or the detection pattern above drifted and is now silently checking nothing." >&2
  exit 1
fi

# Assertions run in a subshell so we can source the installer's functions and
# relax the `set -euo pipefail` / EXIT trap / exiting `fail` it installs at top
# level, without affecting this script's own strict mode. Mirrors the structure
# of check-guided-setup-env-roundtrip.sh.
(
  # Sourcing the installer runs top-level code that derives ENV_FILE from
  # WORK_DIR="${BREEZE_SETUP_DIR:-$(pwd)}". Point it at the sandbox BEFORE the
  # source so nothing touches the developer's real ./.env.
  export BREEZE_SETUP_DIR="${TMP_DIR}"
  # shellcheck source=/dev/null
  source "${FUNCTIONS_FILE}" >/dev/null 2>&1
  ENV_FILE="${TMP_DIR}/.env"
  trap - EXIT
  set +e +u +o pipefail
  warn() { :; }
  log() { :; }
  fail() { printf 'fail:%s\n' "$*" >&2; return 1; }

  fails=0
  checked=0
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    [[ -n "${value}" ]] || continue
    checked=$((checked + 1))
    if ! looks_like_placeholder "${value}"; then
      printf 'UNDETECTED PLACEHOLDER: %s=%s\n' "${key}" "${value}"
      fails=$((fails + 1))
    fi
  done < "${CANDIDATES_FILE}"

  # Guard the guard: a predicate that returns true for everything would pass the
  # loop above while breaking the installer (it would regenerate real values the
  # operator deliberately set). Assert it still rejects realistic secrets.
  for real in \
    "8f14e45fceea167a5a36dedd4bea2543" \
    "aGVsbG8td29ybGQtdGhpcy1pcy1hLXJlYWwtc2VjcmV0LXZhbHVl" \
    "breeze.example.com" \
    "0.105.1"; do
    if looks_like_placeholder "${real}"; then
      printf 'FALSE POSITIVE: looks_like_placeholder rejected a real value: %s\n' "${real}"
      fails=$((fails + 1))
    fi
  done

  printf 'checked %d placeholder value(s) from .env.example\n' "${checked}"
  if ((fails > 0)); then
    printf '\n%d problem(s). Add the new wording to looks_like_placeholder() in scripts/guided-setup.sh.\n' "${fails}" >&2
    printf 'Otherwise the guided installer copies the placeholder into .env verbatim and the API refuses to boot.\n' >&2
    exit 1
  fi
  exit 0
)

echo "OK: every .env.example placeholder is detected by looks_like_placeholder()."
