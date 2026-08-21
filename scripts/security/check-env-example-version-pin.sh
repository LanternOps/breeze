#!/usr/bin/env bash
# Verify that .env.example's BREEZE_VERSION names a version whose images are
# actually published to GHCR.
#
# Why this exists
# ---------------
# .env.example shipped BREEZE_VERSION=0.81.0 for ~25 releases because nothing
# bumped it and nothing checked it. The quickstart tells self-hosters to
# `cp .env.example .env && docker compose up -d`, so every new install pulled
# 0.81.0 — and `ghcr.io/lanternops/breeze/portal:0.81.0` does not exist, because
# the portal service was added to compose after that release. The result was a
# hard `not found` on first boot for 100% of new self-hosters.
#
# "Bump it at release time" alone does NOT fix this: the GitHub Release and the
# git tag are created BEFORE the image builds run (release.yml's build-docker-*
# jobs declare `needs: [create-release]`), so a signing or build failure leaves a
# tag with no images. That is not hypothetical — v0.105.2 and v0.106.0 are both
# tagged today with nothing published. A release-time bump would have pinned
# .env.example to exactly those broken versions.
#
# So the invariant is checked against the registry, which is the only thing that
# knows what an operator can actually pull: every Breeze image repo must carry
# the pinned tag.
#
# Usage:
#   scripts/security/check-env-example-version-pin.sh            # check .env.example
#   scripts/security/check-env-example-version-pin.sh 0.105.1    # check a version
#
# Exits non-zero (with the missing repos named) if any image is absent.
# Exits 0 with a warning if GHCR is unreachable — this must not turn a registry
# outage into a red build.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY_HOST="ghcr.io"
IMAGE_NAMESPACE="lanternops/breeze"
# The four repos .env.example's BREEZE_*_IMAGE_REF lines resolve to. `portal` is
# the one that catches a stale pin, so it must never be dropped from this list.
IMAGE_REPOS=(api web portal binaries)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

read_pinned_version() {
  local env_example="${REPO_ROOT}/.env.example"
  [[ -f "${env_example}" ]] || fail "${env_example} not found"

  local value
  value="$(awk -F= '/^BREEZE_VERSION=/ { print $2; exit }' "${env_example}")"
  [[ -n "${value}" ]] || fail ".env.example does not set BREEZE_VERSION"
  printf '%s' "${value}"
}

# Anonymous pull token. Public packages issue one without credentials, so this
# works on forks and unauthenticated CI alike.
registry_token() {
  local repo="$1" body
  body="$(curl -fsSL --connect-timeout 5 --max-time 15 \
    "https://${REGISTRY_HOST}/token?scope=repository:${IMAGE_NAMESPACE}/${repo}:pull&service=${REGISTRY_HOST}" 2>/dev/null)" || return 1
  printf '%s' "${body}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

# Prints the HTTP status for the manifest, or nothing if the registry could not
# be reached at all (so a network failure is distinguishable from a 404).
manifest_status() {
  local repo="$1" version="$2" token
  token="$(registry_token "${repo}")" || return 1
  [[ -n "${token}" ]] || return 1

  curl -fsS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
    "https://${REGISTRY_HOST}/v2/${IMAGE_NAMESPACE}/${repo}/manifests/${version}" 2>/dev/null || true
}

main() {
  local version="${1:-}"
  if [[ -z "${version}" ]]; then
    version="$(read_pinned_version)"
    printf 'Checking .env.example pin: BREEZE_VERSION=%s\n' "${version}"
  else
    printf 'Checking version: %s\n' "${version}"
  fi

  local missing=() unreachable=0 repo status
  for repo in "${IMAGE_REPOS[@]}"; do
    status="$(manifest_status "${repo}" "${version}")"
    if [[ -z "${status}" ]]; then
      printf '  %-9s %s  (registry unreachable)\n' "${repo}" "${version}"
      unreachable=1
      continue
    fi
    if [[ "${status}" == "200" ]]; then
      printf '  %-9s %s  OK\n' "${repo}" "${version}"
    else
      printf '  %-9s %s  HTTP %s\n' "${repo}" "${version}" "${status}"
      missing+=("${repo}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    printf '\n' >&2
    fail "$(printf 'BREEZE_VERSION=%s is not fully published to GHCR. Missing: %s\n' \
      "${version}" "${missing[*]}")
Self-hosters following the quickstart will hit \`not found\` on \`docker compose up\`.
Pin .env.example to the newest version where ALL of (${IMAGE_REPOS[*]}) are published —
a tagged release is not necessarily a published one."
  fi

  if ((unreachable == 1)); then
    printf 'WARN: could not reach %s for every repo; pin not fully verified.\n' "${REGISTRY_HOST}" >&2
    exit 0
  fi

  printf 'OK: BREEZE_VERSION=%s is published for all %d image repos.\n' "${version}" "${#IMAGE_REPOS[@]}"
}

main "$@"
