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

curl -sSfL -o "$workdir/$asset" "$base_url/$asset"
curl -sSfL -o "$workdir/$checksums" "$base_url/$checksums"
(cd "$workdir" && grep "  ${asset}$" "$checksums" | sha256sum -c -)

sudo install -m 0755 "$workdir/$asset" /usr/local/bin/osv-scanner
osv-scanner --version
