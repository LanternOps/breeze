#!/usr/bin/env bash
#
# build-edition.sh — edition-aware `go build` driver for the Breeze agent
# binary family (agent, backup, watchdog, user-helper, desktop-helper).
#
# Every release/CI go-build call site should route through this script
# instead of invoking `go build` directly, so the fail-closed edition rules
# below are enforced in exactly one place rather than duplicated (and
# potentially drifted) across release.yml, ci.yml, and dev-build-agent.yml.
#
# Editions:
#   self-host     — repo default. BREEZE_ALLOWED_HOSTS must be EMPTY/unset.
#                    No hostpolicy -X flags are emitted; the build is
#                    unrestricted (agent/internal/hostpolicy is inert).
#   hosted-gap    — BREEZE_ALLOWED_HOSTS must be set (non-empty). Emits
#                    -X .../hostpolicy.allowedHosts=<value>. Existing-fleet
#                    violations are reported but not hard-enforced.
#   hosted-strict — same as hosted-gap, plus -X .../hostpolicy.strictMode=1.
#
# The self-host / hosted-* checks are deliberately fail-closed in BOTH
# directions: a self-host build refuses to run if BREEZE_ALLOWED_HOSTS is
# set (a hosted allowlist must never leak into a public, unsigned artifact),
# and a hosted-* build refuses to run if it is NOT set (an accidentally-empty
# allowlist would silently ship an "unrestricted" build under a hosted label).
#
# This script never echoes the CONTENTS of BREEZE_ALLOWED_HOSTS. Use
# --print-ldflags for a dry run that prints the assembled -ldflags string
# with the host list redacted.
#
# Usage:
#   build-edition.sh --edition self-host|hosted-gap|hosted-strict \
#     --component agent|backup|watchdog|user-helper|desktop-helper \
#     --goos GOOS --goarch GOARCH --version VERSION --out PATH \
#     [--windowsgui] [--print-ldflags]
#
# Runs on ubuntu/macos/windows GitHub runners via `shell: bash`.

set -euo pipefail

HOSTPOLICY_PKG="github.com/breeze-rmm/agent/internal/hostpolicy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: build-edition.sh --edition <self-host|hosted-gap|hosted-strict> \
         --component <agent|backup|watchdog|user-helper|desktop-helper> \
         --goos <GOOS> --goarch <GOARCH> --version <VERSION> --out <PATH> \
         [--windowsgui] [--print-ldflags]

  --edition        Build edition. Controls hostpolicy ldflag injection.
  --component      Which agent-family binary to build.
  --goos            GOOS to cross-compile for (exported to the build).
  --goarch          GOARCH to cross-compile for (exported to the build).
  --version         Value baked into -X main.version=.
  --out             Output path for the built binary. Resolved the same way
                     `go build -C agent -o <PATH>` resolves it: relative to
                     the agent/ module directory, not the caller's cwd.
                     Required unless --print-ldflags is given.
  --windowsgui       Add -H windowsgui to -ldflags (GUI-subsystem builds).
  --print-ldflags     Dry run: print the assembled -ldflags string, with any
                     BREEZE_ALLOWED_HOSTS value redacted, and exit without
                     invoking `go build`. Still enforces the fail-closed
                     edition rules below.

Environment:
  BREEZE_ALLOWED_HOSTS   Comma-separated hosted control-plane allowlist.
                         Required (non-empty) for hosted-gap/hosted-strict;
                         forbidden (must be empty/unset) for self-host.
  CGO_ENABLED             Passed through if already set by the caller;
                         defaults to 0 otherwise.
EOF
}

edition=""
component=""
goos=""
goarch=""
version=""
out=""
windowsgui=0
print_ldflags=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --edition)
      edition="${2:-}"
      shift 2
      ;;
    --component)
      component="${2:-}"
      shift 2
      ;;
    --goos)
      goos="${2:-}"
      shift 2
      ;;
    --goarch)
      goarch="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    --out)
      out="${2:-}"
      shift 2
      ;;
    --windowsgui)
      windowsgui=1
      shift
      ;;
    --print-ldflags)
      print_ldflags=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "build-edition.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$edition" in
  self-host|hosted-gap|hosted-strict) ;;
  "")
    echo "build-edition.sh: --edition is required" >&2
    exit 2
    ;;
  *)
    echo "build-edition.sh: unknown --edition '${edition}' (want self-host, hosted-gap, or hosted-strict)" >&2
    exit 2
    ;;
esac

# Component -> package path map. A function (not an associative array) so
# this stays portable to bash 3.2, which is still what `shell: bash` can
# resolve to on some macOS runner images.
component_package() {
  case "$1" in
    agent) echo "./cmd/breeze-agent" ;;
    backup) echo "./cmd/breeze-backup" ;;
    watchdog) echo "./cmd/breeze-watchdog" ;;
    user-helper) echo "./cmd/breeze-user-helper" ;;
    desktop-helper) echo "./cmd/breeze-desktop-helper" ;;
    *) return 1 ;;
  esac
}

if [ -z "$component" ]; then
  echo "build-edition.sh: --component is required" >&2
  exit 2
fi

pkg_path="$(component_package "$component")" || {
  echo "build-edition.sh: unknown --component '${component}' (want agent, backup, watchdog, user-helper, or desktop-helper)" >&2
  exit 2
}

pkg_dir="${AGENT_DIR}/${pkg_path#./}"
if [ ! -d "$pkg_dir" ]; then
  echo "build-edition.sh: package directory for component '${component}' not found: ${pkg_dir}" >&2
  exit 2
fi

if [ -z "$goos" ]; then
  echo "build-edition.sh: --goos is required" >&2
  exit 2
fi
if [ -z "$goarch" ]; then
  echo "build-edition.sh: --goarch is required" >&2
  exit 2
fi
if [ -z "$version" ]; then
  echo "build-edition.sh: --version is required" >&2
  exit 2
fi
if [ -z "$out" ] && [ "$print_ldflags" -ne 1 ]; then
  echo "build-edition.sh: --out is required (unless --print-ldflags is given)" >&2
  exit 2
fi

host_var="${BREEZE_ALLOWED_HOSTS:-}"

ldflags="-s -w -X main.version=${version}"
display_ldflags="-s -w -X main.version=${version}"

case "$edition" in
  self-host)
    if [ -n "$host_var" ]; then
      echo "build-edition.sh: BREEZE_ALLOWED_HOSTS is set but --edition is self-host — refusing to build a public self-host artifact with a hosted allowlist embedded. Unset BREEZE_ALLOWED_HOSTS, or pass --edition hosted-gap/hosted-strict." >&2
      exit 1
    fi
    ;;
  hosted-gap|hosted-strict)
    if [ -z "$host_var" ]; then
      echo "build-edition.sh: --edition ${edition} requires BREEZE_ALLOWED_HOSTS to be set (non-empty) — refusing to build a hosted artifact with no allowlist (would silently ship unrestricted)." >&2
      exit 1
    fi
    ldflags="${ldflags} -X ${HOSTPOLICY_PKG}.allowedHosts=${host_var}"
    display_ldflags="${display_ldflags} -X ${HOSTPOLICY_PKG}.allowedHosts=<redacted>"
    if [ "$edition" = "hosted-strict" ]; then
      ldflags="${ldflags} -X ${HOSTPOLICY_PKG}.strictMode=1"
      display_ldflags="${display_ldflags} -X ${HOSTPOLICY_PKG}.strictMode=1"
    fi
    ;;
esac

if [ "$windowsgui" -eq 1 ]; then
  ldflags="${ldflags} -H windowsgui"
  display_ldflags="${display_ldflags} -H windowsgui"
fi

if [ "$print_ldflags" -eq 1 ]; then
  echo "$display_ldflags"
  exit 0
fi

: "${CGO_ENABLED:=0}"
export CGO_ENABLED
export GOOS="$goos"
export GOARCH="$goarch"

echo "build-edition.sh: component=${component} edition=${edition} goos=${goos} goarch=${goarch} cgo_enabled=${CGO_ENABLED} out=${out}" >&2

exec go build -C "$AGENT_DIR" -ldflags="$ldflags" -o "$out" "$pkg_path"
