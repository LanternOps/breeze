#!/usr/bin/env bash
set -euo pipefail

# Installs a pinned, checksum-verified osv-scanner for the dependency audit.
#
# Mirrors the Gitleaks install in .github/workflows/secret-scan.yml: pin the
# version, fetch the upstream SHA256SUMS, verify the downloaded binary against
# it, and only then install. Never pipe a remote binary straight into a shell
# or an install target.

OSV_SCANNER_VERSION="${OSV_SCANNER_VERSION:-2.4.0}"
asset="osv-scanner_linux_amd64"
checksums="osv-scanner_SHA256SUMS"
base_url="https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# --retry alone only covers timeouts and HTTP 408/429/5xx; --retry-all-errors is
# needed for transient TCP resets (curl exit 35 "Recv failure: Connection reset
# by peer"), which have flaked the Security Audit job.
curl_fetch() {
  curl -sSfL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 15 -o "$1" "$2"
}

curl_fetch "$workdir/$asset" "$base_url/$asset"
curl_fetch "$workdir/$checksums" "$base_url/$checksums"
(cd "$workdir" && grep "  ${asset}$" "$checksums" | sha256sum -c -)

sudo install -m 0755 "$workdir/$asset" /usr/local/bin/osv-scanner
osv-scanner --version
