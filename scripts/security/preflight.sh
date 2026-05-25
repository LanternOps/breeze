#!/usr/bin/env bash
#
# Mirror the CI Security Scanning + Security Audit gates locally so a contributor
# can run the same checks that block PRs before pushing. Maps 1:1 to jobs in
# .github/workflows/security.yml and the security-audit job in
# .github/workflows/ci.yml.
#
# Usage:
#   bash scripts/security/preflight.sh           # all checks
#   bash scripts/security/preflight.sh --fast    # skip Trivy image scan (saves ~5-10 min)
#   bash scripts/security/preflight.sh --strict  # treat skipped checks as failures
#   bash scripts/security/preflight.sh --help    # this message
#
# First-time setup (each developer installs these once):
#   - pnpm (matches packageManager field in package.json)
#   - go install golang.org/x/vuln/cmd/govulncheck@latest
#   - cargo install cargo-audit --locked
#   - docker (or OrbStack/Colima) for the Trivy scans, OR `brew install trivy`
#
# Exit code: 0 if every required check passes, non-zero on any FAIL. Skipped
# checks (missing tooling) are non-fatal unless --strict is passed.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Guard the cd: set -e is intentionally omitted so this script runs all gates
# and reports, but that means a silently-failed cd would scan the wrong dir
# and could exit 0 — the exact false-confidence failure mode this script
# exists to prevent. SC2164.
cd "$ROOT_DIR" || exit 1

FAST_MODE="0"
STRICT_MODE="0"
for arg in "$@"; do
  case "$arg" in
    --fast) FAST_MODE="1" ;;
    --strict) STRICT_MODE="1" ;;
    --help|-h)
      # Split into separate -e expressions so BSD sed (macOS default) accepts the
      # range-with-quit pattern — GNU sed accepts ;-separated commands inside {...}
      # but BSD sed rejects them with "extra characters at the end of p command".
      sed -n -e '2,/^# Exit code/{' -e '/^# Exit code/q' -e 'p' -e '}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_FAIL=$'\033[31m'; C_SKIP=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=""; C_FAIL=""; C_SKIP=""; C_DIM=""; C_RESET=""
fi

PASS_LIST=()
FAIL_LIST=()
SKIP_LIST=()

step() {
  local name="$1"; shift
  printf '\n%s== %s ==%s\n' "$C_DIM" "$name" "$C_RESET"
  if "$@"; then
    PASS_LIST+=("$name")
    printf '%s[PASS]%s %s\n' "$C_OK" "$C_RESET" "$name"
  else
    FAIL_LIST+=("$name")
    printf '%s[FAIL]%s %s\n' "$C_FAIL" "$C_RESET" "$name"
  fi
}

skip() {
  local name="$1"; local reason="$2"
  SKIP_LIST+=("$name")
  printf '\n%s[SKIP]%s %s — %s\n' "$C_SKIP" "$C_RESET" "$name" "$reason"
}

# 1) NPM Audit — CI: security.yml job npm-audit + ci.yml job security-audit step 1
if command -v pnpm >/dev/null 2>&1; then
  step "pnpm audit --audit-level=critical" \
    pnpm audit --audit-level=critical
else
  skip "pnpm audit" "pnpm not on PATH; corepack-enable or brew install pnpm"
fi

# 2) Go Vulnerability Check — CI: security.yml job go-vuln
if command -v govulncheck >/dev/null 2>&1; then
  step "govulncheck (agent/)" bash -c '
    cd agent && CGO_ENABLED=0 govulncheck ./...
  '
else
  skip "govulncheck" "install: go install golang.org/x/vuln/cmd/govulncheck@latest"
fi

# 3) Cargo Audit — CI: security.yml job cargo-audit (two workspaces)
if command -v cargo-audit >/dev/null 2>&1; then
  step "cargo audit (apps/helper/src-tauri)" bash -c '
    cd apps/helper/src-tauri && cargo audit --deny warnings
  '
  step "cargo audit (apps/viewer/src-tauri)" bash -c '
    cd apps/viewer/src-tauri && cargo audit --deny warnings
  '
else
  skip "cargo audit (helper)" "install: cargo install cargo-audit --locked"
  skip "cargo audit (viewer)" "install: cargo install cargo-audit --locked"
fi

# 4) Supply-chain + relay/edge hardening — CI: ci.yml job security-audit steps 2 & 3
step "supply-chain hardening guard" bash scripts/security/check-supply-chain-hardening.sh
step "relay/edge hardening guard" bash scripts/security/check-relay-edge-hardening.sh

# 5) Trivy filesystem scan — CI: security.yml job trivy-fs-scan, blocking step
# Prefer the native trivy binary if installed; fall back to the official Docker
# image. The CI workflow uses the aquasecurity/trivy-action GH Action, which
# under the hood runs the same scan against the same severities — we mirror the
# blocking step's flags here (HIGH,CRITICAL, exit-code 1).
if command -v trivy >/dev/null 2>&1; then
  step "trivy fs scan (HIGH,CRITICAL, blocking)" \
    trivy fs --severity HIGH,CRITICAL --exit-code 1 .
elif command -v docker >/dev/null 2>&1; then
  # --ignorefile: container CWD is /, not /scan, so Trivy's default
  # .trivyignore auto-load doesn't fire. Pointing at the in-container
  # path keeps the Docker fallback in sync with native + CI behavior
  # (CVE-2024-29415 / node-ip is suppressed identically).
  step "trivy fs scan via Docker (HIGH,CRITICAL, blocking)" \
    docker run --rm -v "$ROOT_DIR":/scan:ro aquasec/trivy:latest \
      fs --severity HIGH,CRITICAL --exit-code 1 \
      --ignorefile /scan/.trivyignore /scan
else
  skip "trivy fs scan" "install: brew install trivy  OR start Docker/OrbStack"
fi

# 6) Trivy image scan — CI: security.yml job trivy-image-scan
# Builds API + Web images then scans them. Slow (~5-10 min on a cold cache),
# skipped under --fast.
if [ "$FAST_MODE" = "1" ]; then
  skip "trivy image scan (api+web)" "--fast skipped; run without --fast to include"
elif ! command -v docker >/dev/null 2>&1; then
  skip "trivy image scan (api+web)" "docker not on PATH"
else
  step "build breeze-api image (security-scan tag)" bash -c '
    docker build -f docker/Dockerfile.api -t breeze-api:security-scan .
  '
  step "build breeze-web image (security-scan tag)" bash -c '
    docker build -f docker/Dockerfile.web -t breeze-web:security-scan .
  '
  TRIVY_IMG_CMD=(trivy image --severity HIGH,CRITICAL --exit-code 1)
  if command -v trivy >/dev/null 2>&1; then
    step "trivy image scan: breeze-api" "${TRIVY_IMG_CMD[@]}" breeze-api:security-scan
    step "trivy image scan: breeze-web" "${TRIVY_IMG_CMD[@]}" breeze-web:security-scan
  else
    # Mount .trivyignore + --ignorefile: same rationale as the fs Docker
    # fallback above — container CWD is /, so the default auto-load
    # doesn't fire. We mount only the ignore file (the image scan
    # doesn't need the rest of the repo) and point Trivy at it
    # explicitly so CI's suppressions apply locally too.
    step "trivy image scan: breeze-api (via Docker)" \
      docker run --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$ROOT_DIR/.trivyignore":/scan/.trivyignore:ro \
        aquasec/trivy:latest image --severity HIGH,CRITICAL --exit-code 1 \
        --ignorefile /scan/.trivyignore breeze-api:security-scan
    step "trivy image scan: breeze-web (via Docker)" \
      docker run --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$ROOT_DIR/.trivyignore":/scan/.trivyignore:ro \
        aquasec/trivy:latest image --severity HIGH,CRITICAL --exit-code 1 \
        --ignorefile /scan/.trivyignore breeze-web:security-scan
  fi
fi

# Summary
printf '\n%s== Preflight summary ==%s\n' "$C_DIM" "$C_RESET"
printf '  %sPassed:%s  %d\n' "$C_OK" "$C_RESET" "${#PASS_LIST[@]}"
printf '  %sFailed:%s  %d\n' "$C_FAIL" "$C_RESET" "${#FAIL_LIST[@]}"
printf '  %sSkipped:%s %d\n' "$C_SKIP" "$C_RESET" "${#SKIP_LIST[@]}"

if [ "${#FAIL_LIST[@]}" -gt 0 ]; then
  printf '\n%sFailed checks:%s\n' "$C_FAIL" "$C_RESET"
  for n in "${FAIL_LIST[@]}"; do printf '  - %s\n' "$n"; done
  exit 1
fi

if [ "$STRICT_MODE" = "1" ] && [ "${#SKIP_LIST[@]}" -gt 0 ]; then
  printf '\n%s--strict: skipped checks count as failures%s\n' "$C_FAIL" "$C_RESET"
  exit 1
fi

if [ "${#SKIP_LIST[@]}" -gt 0 ]; then
  printf '\n%sAll required checks passed (%d skipped — install tooling or use --strict for full fidelity).%s\n' \
    "$C_OK" "${#SKIP_LIST[@]}" "$C_RESET"
else
  printf '\n%sAll required checks passed.%s\n' "$C_OK" "$C_RESET"
fi
exit 0
