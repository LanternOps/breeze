#!/usr/bin/env bash
# =============================================================================
# smoke.sh — post-deploy smoke test for NU RMM (Breeze).
#
# Usage:
#   SMOKE_EMAIL=... SMOKE_PASSWORD=... [BASE_URL=https://rmm.nodesunlimited.com] ./smoke.sh
#
# Checks:
#   1. GET  /            -> 200
#   2. GET  /login       -> 200
#   3. POST /api/v1/auth/login -> returns a token
#   4. GET  /api/v1/devices    -> >=1 device; prints hostname + status
#   5. GET  /api/v1/agents/download/linux/arm64 -> 200 or 302
#   6. GET  /api/v1/viewers/download/macos      -> 200 or 302
#
# Exits non-zero if ANY check fails.
# =============================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-https://rmm.nodesunlimited.com}"
: "${SMOKE_EMAIL:?SMOKE_EMAIL must be set}"
: "${SMOKE_PASSWORD:?SMOKE_PASSWORD must be set}"

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }

FAILURES=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1" >&2; FAILURES=$((FAILURES + 1)); }

check_status_200() {
  local label="$1" path="$2" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}${path}")" || code="000"
  if [[ "${code}" == "200" ]]; then
    pass "${label} (${path} -> ${code})"
  else
    fail "${label} (${path} -> ${code}, expected 200)"
  fi
}

check_status_200_or_302() {
  local label="$1" path="$2" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}${path}")" || code="000"
  if [[ "${code}" == "200" || "${code}" == "302" ]]; then
    pass "${label} (${path} -> ${code})"
  else
    fail "${label} (${path} -> ${code}, expected 200/302)"
  fi
}

# --- 1 & 2: basic pages -----------------------------------------------------
check_status_200 "web root" "/"
check_status_200 "login page" "/login"

# --- 3: API login -----------------------------------------------------------
TOKEN=""
login_resp="$(curl -sS -X POST "${BASE_URL}/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg e "${SMOKE_EMAIL}" --arg p "${SMOKE_PASSWORD}" '{email: $e, password: $p}')" \
  || true)"

# The live API nests the token: {"user":{...},"tokens":{"accessToken":"..."}}.
# The flat variants are kept as fallbacks for older/newer response shapes.
TOKEN="$(printf '%s' "${login_resp}" | jq -r '.tokens.accessToken // .token // .accessToken // .access_token // .data.token // empty' 2>/dev/null || true)"

if [[ -n "${TOKEN}" ]]; then
  pass "auth login (token received)"
else
  fail "auth login (no token in response: $(printf '%s' "${login_resp}" | head -c 300))"
fi

# --- 4: devices list --------------------------------------------------------
if [[ -n "${TOKEN}" ]]; then
  devices_resp="$(curl -sS "${BASE_URL}/api/v1/devices" \
    -H "Authorization: Bearer ${TOKEN}" || true)"
  device_count="$(printf '%s' "${devices_resp}" \
    | jq -r 'if type == "array" then length elif (.devices? | type) == "array" then (.devices | length) elif (.data? | type) == "array" then (.data | length) else 0 end' 2>/dev/null || echo 0)"
  if [[ "${device_count}" -ge 1 ]]; then
    pass "devices list (${device_count} device(s))"
    printf '%s' "${devices_resp}" \
      | jq -r '(if type == "array" then . elif (.devices? | type) == "array" then .devices else .data end)[] | "      device: \(.hostname // .name // "unknown")  status: \(.status // .state // "unknown")"' \
      2>/dev/null || echo "      (could not pretty-print device rows)"
  else
    fail "devices list (expected >=1 device, got ${device_count}: $(printf '%s' "${devices_resp}" | head -c 300))"
  fi
else
  fail "devices list (skipped: no auth token)"
fi

# --- 5 & 6: binary downloads ------------------------------------------------
check_status_200_or_302 "agent download linux/arm64" "/api/v1/agents/download/linux/arm64"
check_status_200_or_302 "viewer download macos" "/api/v1/viewers/download/macos"

# --- summary ----------------------------------------------------------------
echo ""
if [[ "${FAILURES}" -gt 0 ]]; then
  echo "SMOKE TEST FAILED: ${FAILURES} check(s) failed against ${BASE_URL}" >&2
  exit 1
fi
echo "SMOKE TEST PASSED: all checks green against ${BASE_URL}"
