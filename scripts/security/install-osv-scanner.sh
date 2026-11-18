#!/usr/bin/env bash
set -euo pipefail

# Installs a pinned, digest-verified osv-scanner for the dependency audit.
#
# The trust anchor is OSV_SCANNER_SHA256 below, pinned in this repo. Every
# candidate binary, whether from the cache or from a download, is hashed and
# compared with it before install. No source is trusted on its own. Never pipe
# a remote binary into a shell or an install target.
#
# Order (#11367):
#   1. Cache. .github/actions/restore-osv-scanner restores the cache dir; only
#      ci-cache-seed.yml on main saves it. A cached copy that matches the pin
#      is installed with no network call, so a release-download outage does
#      not reach a job that got a cache hit.
#   2. Download. Up to $attempts rounds, with exponential backoff between
#      rounds (4+8+16+32+64 = 124 s by default). Each round tries the
#      release-download URL, then the REST asset endpoint. The REST endpoint is
#      served separately and kept working while the release-download URL
#      returned 504 on 2026-11-08. Any curl failure is retried: HTTP 5xx/4xx
#      (curl exit 22), connection resets (52/56), timeouts (28). A download
#      whose digest does not match is discarded and logged. Each request is
#      capped at 90 s, so the worst case is 12 x 90 + 124 s, about 20 min.
#      That is under the step timeouts in ci.yml and security.yml and the
#      seed job's timeout; install-osv-scanner.test.mjs checks this.
#   3. Nothing verified: one ::error:: line, then exit 1. The audit never runs
#      without the scanner, so the job fails closed.
#
# Bumping the version: change the three pins together, then the cache key in
# .github/actions/restore-osv-scanner/action.yml and ci-cache-seed.yml
# (install-osv-scanner.test.mjs checks that they agree). Read the asset id and
# digest from GitHub, and cross-check the digest against the release's
# osv-scanner_SHA256SUMS:
#   gh api repos/google/osv-scanner/releases/tags/vX.Y.Z \
#     --jq '.assets[] | select(.name == "osv-scanner_linux_amd64") | [.id, .digest]'
#
# Test seams (install-osv-scanner.test.mjs): OSV_SCANNER_RELEASE_URL,
# OSV_SCANNER_API_URL, OSV_SCANNER_INSTALL_DIR, OSV_SCANNER_CACHE_DIR,
# OSV_SCANNER_ATTEMPTS, OSV_SCANNER_BACKOFF_BASE. None of them changes what is
# accepted. The digest has no override. The test runs a copy of this file with
# the pin rewritten.

OSV_SCANNER_VERSION=2.4.0
OSV_SCANNER_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0
OSV_SCANNER_ASSET_ID=451242336

release_url="${OSV_SCANNER_RELEASE_URL:-https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64}"
api_url="${OSV_SCANNER_API_URL:-https://api.github.com/repos/google/osv-scanner/releases/assets/${OSV_SCANNER_ASSET_ID}}"
install_dir="${OSV_SCANNER_INSTALL_DIR:-/usr/local/bin}"
cache_dir="${OSV_SCANNER_CACHE_DIR:-$HOME/.cache/osv-scanner}"
attempts="${OSV_SCANNER_ATTEMPTS:-6}"
backoff_base="${OSV_SCANNER_BACKOFF_BASE:-4}"

[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || { echo "::error::OSV_SCANNER_ATTEMPTS must be a positive integer, got '${attempts}'" >&2; exit 2; }
[[ "$backoff_base" =~ ^[0-9]+$ ]] || { echo "::error::OSV_SCANNER_BACKOFF_BASE must be a non-negative integer, got '${backoff_base}'" >&2; exit 2; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
candidate="$workdir/osv-scanner"

die() {
  echo "::error title=osv-scanner install failed::$*"
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Every step checks its own status, rather than relying on errexit, so a failed
# install can never fall through to a stale osv-scanner already on PATH.
install_verified() {
  local target="$install_dir/osv-scanner"
  if [[ -w "$install_dir" ]]; then
    install -m 0755 "$candidate" "$target" || die "could not install the verified osv-scanner to ${target}"
  else
    sudo install -m 0755 "$candidate" "$target" || die "could not install the verified osv-scanner to ${target} (sudo)"
  fi
  "$target" --version || die "the installed ${target} did not run (--version failed)"
}

# 1. Cache. Hash a private copy, so the file installed is the file checked.
cache_state="no cached copy was restored"
if [[ -f "$cache_dir/osv-scanner" ]]; then
  if cp "$cache_dir/osv-scanner" "$candidate"; then
    cached_sha="$(sha256_of "$candidate")" || die "could not compute the SHA-256 of the cached osv-scanner"
    if [[ "$cached_sha" == "$OSV_SCANNER_SHA256" ]]; then
      echo "Using the cached osv-scanner v${OSV_SCANNER_VERSION} (SHA-256 verified)."
      install_verified
      exit 0
    fi
    echo "::warning title=osv-scanner cache rejected::cached osv-scanner does not match the pinned SHA-256 (got ${cached_sha}); downloading instead"
    rm -f "$candidate"
    cache_state="the cached copy was rejected (SHA-256 mismatch: delete the osv-scanner-* Actions cache entry)"
  else
    echo "::warning title=osv-scanner cache unreadable::could not read ${cache_dir}/osv-scanner; downloading instead"
    cache_state="the cached copy could not be read"
  fi
fi

# 2. Download.
round_errors=() # this round's failures, one per source
download_mismatch=0
# Returns 0 only for a downloaded file whose digest matches the pin.
fetch_verified() {
  local label="$1" url="$2" accept="$3" code rc=0 got err
  rm -f "$candidate"
  code="$(curl -sS -L --fail --connect-timeout 15 --max-time 90 --speed-limit 10240 --speed-time 30 \
    -H "Accept: ${accept}" -o "$candidate" -w '%{http_code}' "$url")" || rc=$?
  if ((rc != 0)); then
    # With --fail, an HTTP error is usually curl exit 22, but some curl builds
    # report it as 56 over HTTP/2. Report the status whenever one came back.
    if [[ "$code" =~ ^[45][0-9][0-9]$ ]]; then
      err="HTTP ${code} from ${label} (curl exit ${rc})"
    else
      err="curl exit ${rc} from ${label}"
    fi
    round_errors+=("$err")
    echo "osv-scanner download failed: ${err}" >&2
    return 1
  fi
  if ! got="$(sha256_of "$candidate")"; then
    round_errors+=("could not compute the SHA-256 of the download from ${label}")
    rm -f "$candidate"
    return 1
  fi
  if [[ "$got" != "$OSV_SCANNER_SHA256" ]]; then
    download_mismatch=1
    err="SHA-256 mismatch from ${label} (got ${got})"
    round_errors+=("$err")
    echo "::warning title=osv-scanner digest mismatch::${err}; discarded"
    rm -f "$candidate"
    return 1
  fi
  return 0
}

delay="$backoff_base"
summary=""
for ((round = 1; round <= attempts; round++)); do
  round_errors=()
  if fetch_verified "the release download" "$release_url" "*/*" \
    || fetch_verified "the REST asset endpoint" "$api_url" "application/octet-stream"; then
    echo "Downloaded osv-scanner v${OSV_SCANNER_VERSION} (SHA-256 verified)."
    # Best effort: ci-cache-seed.yml saves this dir, and checks the binary is
    # in it before it saves. CI jobs only restore.
    if mkdir -p "$cache_dir" && cp "$candidate" "$cache_dir/osv-scanner.tmp" \
      && mv -f "$cache_dir/osv-scanner.tmp" "$cache_dir/osv-scanner"; then
      :
    else
      echo "::warning::could not write the verified osv-scanner to ${cache_dir}"
    fi
    install_verified
    exit 0
  fi
  # Both sources failed, so round_errors holds two entries.
  summary="$(printf '%s; ' "${round_errors[@]}")"
  summary="${summary%; }"
  if ((round < attempts)); then
    echo "osv-scanner download round ${round}/${attempts} failed (${summary}); retrying in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  else
    echo "osv-scanner download round ${round}/${attempts} failed (${summary})" >&2
  fi
done

# 3. Fail closed.
if ((download_mismatch)); then
  advice="A download did not match the pinned SHA-256. Check the pin and the release before re-running."
else
  advice="Re-run it once GitHub release downloads recover."
fi
echo "::error title=osv-scanner unavailable::Could not get a verified osv-scanner v${OSV_SCANNER_VERSION}: ${cache_state}, and ${attempts} download rounds from GitHub failed (last round: ${summary}). The dependency audit cannot run without it, so this job fails closed. ${advice}"
exit 1
