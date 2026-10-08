#!/usr/bin/env bash
#
# build-edition_test.sh — exercises the fail-closed edition matrix in
# build-edition.sh, plus one real self-host build to prove the happy path
# actually produces a binary. Wired into ci.yml's `test-agent` job as a
# quick step (no network access beyond the Go module proxy, no GH runner
# secrets required).
#
# Usage: agent/scripts/build-edition_test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_EDITION="${SCRIPT_DIR}/build-edition.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

pass() {
  echo "PASS: $*"
}

# assert_refuses NAME EXPECTED_EXIT_CODE -- runs build-edition.sh with the
# given args (via stdin-free array expansion below) and asserts it exits
# non-zero and prints something on stderr — i.e. it refused to build.
assert_refuses() {
  local name="$1"
  shift
  local out
  local status=0
  out="$("${BUILD_EDITION}" "$@" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    fail "${name}: expected non-zero exit, got 0. Output: ${out}"
    return
  fi
  if [ -z "$out" ]; then
    fail "${name}: refused with no diagnostic output"
    return
  fi
  pass "${name} (exit ${status})"
}

# --- Refusal matrix -------------------------------------------------------

# self-host + BREEZE_ALLOWED_HOSTS set MUST refuse (a hosted allowlist must
# never leak into a public self-host build).
BREEZE_ALLOWED_HOSTS="hosted-a.example" \
  assert_refuses "self-host refuses when BREEZE_ALLOWED_HOSTS is set" \
  --edition self-host --component agent --goos linux --goarch amd64 \
  --version 0.0.0-test --print-ldflags

# hosted-gap without BREEZE_ALLOWED_HOSTS MUST refuse (would silently ship
# an "unrestricted" build under a hosted label).
unset BREEZE_ALLOWED_HOSTS || true
assert_refuses "hosted-gap refuses when BREEZE_ALLOWED_HOSTS is unset" \
  --edition hosted-gap --component agent --goos linux --goarch amd64 \
  --version 0.0.0-test --print-ldflags

# hosted-strict without BREEZE_ALLOWED_HOSTS MUST also refuse.
assert_refuses "hosted-strict refuses when BREEZE_ALLOWED_HOSTS is unset" \
  --edition hosted-strict --component agent --goos linux --goarch amd64 \
  --version 0.0.0-test --print-ldflags

# Unknown edition / component must be rejected (usage error, not a silent
# fallthrough to self-host semantics).
assert_refuses "unknown --edition is rejected" \
  --edition bogus --component agent --goos linux --goarch amd64 \
  --version 0.0.0-test --print-ldflags
assert_refuses "unknown --component is rejected" \
  --edition self-host --component bogus --goos linux --goarch amd64 \
  --version 0.0.0-test --print-ldflags

# --- Happy path: ldflags assembly -----------------------------------------

self_host_ldflags="$("${BUILD_EDITION}" \
  --edition self-host --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
case "$self_host_ldflags" in
  *hostpolicy*)
    fail "self-host ldflags must not reference hostpolicy at all: ${self_host_ldflags}"
    ;;
  "-s -w -X main.version=1.2.3")
    pass "self-host ldflags are exactly -s -w -X main.version=1.2.3"
    ;;
  *)
    fail "unexpected self-host ldflags: ${self_host_ldflags}"
    ;;
esac

hosted_gap_ldflags="$(BREEZE_ALLOWED_HOSTS="hosted-a.example,hosted-b.example" "${BUILD_EDITION}" \
  --edition hosted-gap --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
case "$hosted_gap_ldflags" in
  *"hosted-a.example"*|*"hosted-b.example"*)
    fail "hosted-gap --print-ldflags must redact BREEZE_ALLOWED_HOSTS, got: ${hosted_gap_ldflags}"
    ;;
  *"hostpolicy.allowedHosts=<redacted>"*)
    pass "hosted-gap ldflags carry a redacted allowedHosts flag"
    ;;
  *)
    fail "hosted-gap ldflags missing redacted allowedHosts flag: ${hosted_gap_ldflags}"
    ;;
esac
case "$hosted_gap_ldflags" in
  *strictMode*)
    fail "hosted-gap must NOT emit strictMode: ${hosted_gap_ldflags}"
    ;;
  *)
    pass "hosted-gap omits strictMode"
    ;;
esac

hosted_strict_ldflags="$(BREEZE_ALLOWED_HOSTS="hosted-a.example" "${BUILD_EDITION}" \
  --edition hosted-strict --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
case "$hosted_strict_ldflags" in
  *"hostpolicy.strictMode=1"*)
    pass "hosted-strict ldflags carry strictMode=1"
    ;;
  *)
    fail "hosted-strict ldflags missing strictMode=1: ${hosted_strict_ldflags}"
    ;;
esac
case "$hosted_strict_ldflags" in
  *"hosted-a.example"*)
    fail "hosted-strict --print-ldflags must redact BREEZE_ALLOWED_HOSTS, got: ${hosted_strict_ldflags}"
    ;;
esac

windowsgui_ldflags="$("${BUILD_EDITION}" \
  --edition self-host --component user-helper --goos windows --goarch amd64 \
  --version 1.2.3 --windowsgui --print-ldflags)"
case "$windowsgui_ldflags" in
  *"-H windowsgui")
    pass "--windowsgui appends -H windowsgui"
    ;;
  *)
    fail "expected -H windowsgui at the end of ldflags: ${windowsgui_ldflags}"
    ;;
esac

# --- Branding: operator display strings -----------------------------------

BRAND_PKG="github.com/breeze-rmm/agent/internal/branding"
BRAND_VARS="BREEZE_BRAND_AGENT_DISPLAY_NAME BREEZE_BRAND_AGENT_DESCRIPTION BREEZE_BRAND_WATCHDOG_DISPLAY_NAME BREEZE_BRAND_WATCHDOG_DESCRIPTION BREEZE_BRAND_AGENT_CLI_SHORT BREEZE_BRAND_WATCHDOG_CLI_SHORT"
for v in $BRAND_VARS; do unset "$v" || true; done

# One brand value adds exactly one quoted -X flag and nothing else.
brand_one="$(BREEZE_BRAND_AGENT_DISPLAY_NAME="Example MSP Agent" "${BUILD_EDITION}" \
  --edition self-host --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
expected_one="-s -w -X main.version=1.2.3 -X '${BRAND_PKG}.AgentServiceDisplayName=Example MSP Agent'"
if [ "$brand_one" = "$expected_one" ]; then
  pass "a brand value adds exactly one quoted -X flag"
else
  fail "unexpected ldflags for one brand value: ${brand_one}"
fi

# A blank value counts as unset.
brand_blank="$(BREEZE_BRAND_AGENT_DISPLAY_NAME="   " "${BUILD_EDITION}" \
  --edition self-host --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
if [ "$brand_blank" = "-s -w -X main.version=1.2.3" ]; then
  pass "a blank brand value is treated as unset"
else
  fail "a blank brand value must add no flag: ${brand_blank}"
fi

# All six variables map to their Go variables.
brand_all="$(BREEZE_BRAND_AGENT_DISPLAY_NAME="A1" BREEZE_BRAND_AGENT_DESCRIPTION="A2" \
  BREEZE_BRAND_WATCHDOG_DISPLAY_NAME="W1" BREEZE_BRAND_WATCHDOG_DESCRIPTION="W2" \
  BREEZE_BRAND_AGENT_CLI_SHORT="A3" BREEZE_BRAND_WATCHDOG_CLI_SHORT="W3" \
  "${BUILD_EDITION}" --edition self-host --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags)"
for pair in "AgentServiceDisplayName=A1" "AgentServiceDescription=A2" \
  "WatchdogServiceDisplayName=W1" "WatchdogServiceDescription=W2" \
  "AgentCLIShort=A3" "WatchdogCLIShort=W3"; do
  case "$brand_all" in
    *"-X '${BRAND_PKG}.${pair}'"*)
      pass "ldflags carry ${pair%%=*}"
      ;;
    *)
      fail "ldflags missing ${pair}: ${brand_all}"
      ;;
  esac
done

# Brand flags come before -H windowsgui, which stays last.
brand_gui="$(BREEZE_BRAND_AGENT_DISPLAY_NAME="Example MSP Agent" "${BUILD_EDITION}" \
  --edition self-host --component user-helper --goos windows --goarch amd64 \
  --version 1.2.3 --windowsgui --print-ldflags)"
case "$brand_gui" in
  *"-H windowsgui")
    pass "brand flags keep -H windowsgui last"
    ;;
  *)
    fail "expected -H windowsgui at the end with a brand set: ${brand_gui}"
    ;;
esac

# Invalid values are refused (a newline would inject directives into a unit).
refuse_brand() { # NAME VAR VALUE
  local name="$1" var="$2" value="$3"
  export "${var}=${value}"
  assert_refuses "${name}" \
    --edition self-host --component agent --goos linux --goarch amd64 \
    --version 1.2.3 --print-ldflags
  unset "$var"
}
refuse_brand "brand refuses a newline" BREEZE_BRAND_AGENT_DISPLAY_NAME $'Example\nExecStart=/bin/sh'
refuse_brand "brand refuses a tab" BREEZE_BRAND_AGENT_DISPLAY_NAME $'Example\tAgent'
refuse_brand "brand refuses a single quote" BREEZE_BRAND_AGENT_DISPLAY_NAME "Example's Agent"
refuse_brand "brand refuses a backslash" BREEZE_BRAND_AGENT_DISPLAY_NAME 'Example\Agent'
refuse_brand "brand refuses a percent sign" BREEZE_BRAND_AGENT_DISPLAY_NAME "100% Agent"
refuse_brand "brand refuses a double quote" BREEZE_BRAND_AGENT_DISPLAY_NAME 'Acme "Pro"'
long_257="$(printf 'a%.0s' $(seq 1 257))"
refuse_brand "brand refuses 257 bytes" BREEZE_BRAND_AGENT_DISPLAY_NAME "$long_257"
for v in $BRAND_VARS; do
  refuse_brand "${v} is validated" "$v" "100% Agent"
done

long_256="$(printf 'a%.0s' $(seq 1 256))"
if BREEZE_BRAND_AGENT_DISPLAY_NAME="$long_256" "${BUILD_EDITION}" \
  --edition self-host --component agent --goos linux --goarch amd64 \
  --version 1.2.3 --print-ldflags >/dev/null 2>&1; then
  pass "brand accepts exactly 256 bytes"
else
  fail "brand must accept exactly 256 bytes"
fi

# End to end: a branded build carries the value, so the -ldflags quoting works.
brand_bin="${TMP_DIR}/breeze-watchdog-brandtest"
if ! BREEZE_BRAND_WATCHDOG_CLI_SHORT="Example MSP Watchdog CLI" "${BUILD_EDITION}" \
  --edition self-host --component watchdog \
  --goos "$(go env GOOS)" --goarch "$(go env GOARCH)" \
  --version 0.0.0-brandtest --out "${brand_bin}" >/dev/null 2>&1; then
  fail "branded build of the watchdog failed"
elif grep -qa "Example MSP Watchdog CLI" "${brand_bin}"; then
  pass "a branded build carries the brand value"
else
  fail "branded build does not contain the brand value"
fi

# --- Happy path: real self-host build for the host platform ---------------

host_goos="$(go env GOOS)"
host_goarch="$(go env GOARCH)"
built_bin="${TMP_DIR}/breeze-agent-selftest"

if ! "${BUILD_EDITION}" \
  --edition self-host --component agent \
  --goos "${host_goos}" --goarch "${host_goarch}" \
  --version 0.0.0-selftest --out "${built_bin}"; then
  fail "real self-host build of the agent for ${host_goos}/${host_goarch} failed"
elif [ ! -s "${built_bin}" ]; then
  fail "real self-host build did not produce a non-empty binary at ${built_bin}"
else
  pass "real self-host build produced a binary for ${host_goos}/${host_goarch}"
fi

# --- Summary ----------------------------------------------------------------

if [ "$failures" -ne 0 ]; then
  echo "build-edition_test.sh: ${failures} failure(s)" >&2
  exit 1
fi
echo "build-edition_test.sh: all checks passed"
