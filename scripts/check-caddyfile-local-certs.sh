#!/usr/bin/env bash

# Contract guard for the CADDY_LOCAL_CERTS opt-in in docker/Caddyfile.prod.
#
# Why this guard exists
# ---------------------
# docker/Caddyfile.prod is shared by hosted production and every self-hosted
# install. The internal-CA opt-in is a bare `{$CADDY_LOCAL_CERTS}` placeholder in
# the global options block, which relies on Caddy discarding the blank line the
# placeholder expands to when the variable is empty. That is a property of the
# Caddyfile ADAPTER, not of anything visible by reading the file — a future edit
# (moving the placeholder into the site block, giving it a default, wrapping it in
# a snippet) can keep the same text working for self-hosters while silently
# changing the JSON hosted production runs, or stop the opt-in working at all.
#
# So assert the two properties directly, against the real caddy image:
#
#   1. EMPTY  -> adapts, and produces NO internal issuer. Hosted production and
#                every internet-reachable install are on this path.
#   2. SET    -> adapts, and produces an `internal` issuer so Caddy stops asking
#                Let's Encrypt for a certificate it can never obtain.
#   3. The two adapted configs differ ONLY by the `tls` app. Anything else moving
#                between the states means the placeholder started affecting
#                routing, headers or proxy behavior, which it must never do.
#   4. UNSET  -> identical to EMPTY, so an operator who never defines the variable
#                gets exactly the pre-existing behavior.
#
# A missing prerequisite (no docker CLI, no reachable daemon, unpullable image)
# is a hard failure when CI is set and a skip otherwise: in the required Lint job
# a skip would make this guard silently vacuous, while a developer without Docker
# should not be blocked locally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CADDYFILE="${REPO_ROOT}/docker/Caddyfile.prod"
CADDY_IMAGE="${CADDY_IMAGE_REF:-caddy:2-alpine}"
SITE_ADDRESS="breeze.example.test"

[[ -f "${CADDYFILE}" ]] || {
  echo "FAIL: ${CADDYFILE} not found" >&2
  exit 1
}

# The placeholder itself must still be there. Without it the SET assertion below
# would fail anyway, but naming the missing line makes the failure actionable.
# Matched WITHOUT the closing brace on purpose: a variant like
# `{$CADDY_LOCAL_CERTS:local_certs}` is still "present", and deserves the precise
# semantic failure from the adapt assertions rather than this generic one.
if ! grep -q '{\$CADDY_LOCAL_CERTS' "${CADDYFILE}"; then
  echo "FAIL: docker/Caddyfile.prod no longer contains the {\$CADDY_LOCAL_CERTS} placeholder." >&2
  echo "The internal-CA opt-in is gone; self-hosters on an unreachable domain get" >&2
  echo "ERR_SSL_PROTOCOL_ERROR with no way out. Restore it or delete this guard deliberately." >&2
  exit 1
fi

# Hard-fail under CI, skip locally: a skipped guard in the required Lint job is
# indistinguishable from a passing one, and this is the only check that the
# CADDY_LOCAL_CERTS opt-in stays a no-op when empty.
missing_prereq() {
  if [[ -n "${CI:-}" ]]; then
    echo "FAIL: $1" >&2
    echo "CI is set, so this guard must not skip itself. docker/Caddyfile.prod is shared" >&2
    echo "with hosted production and nothing else proves an empty CADDY_LOCAL_CERTS adapts" >&2
    echo "to unchanged JSON. Fix the runner prerequisite rather than bypassing the check." >&2
    exit 1
  fi
  echo "SKIP: $1 (local run, CI unset)"
  exit 0
}

if ! command -v docker >/dev/null 2>&1; then
  missing_prereq "the docker CLI is not on PATH; this guard adapts the Caddyfile with ${CADDY_IMAGE}"
fi

if ! docker info >/dev/null 2>&1; then
  missing_prereq "no reachable Docker daemon ('docker info' failed); this guard adapts the Caddyfile with ${CADDY_IMAGE}"
fi

if ! docker image inspect "${CADDY_IMAGE}" >/dev/null 2>&1 \
  && ! docker pull -q "${CADDY_IMAGE}" >/dev/null 2>&1; then
  missing_prereq "the caddy image ${CADDY_IMAGE} is neither present locally nor pullable"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

adapt() {
  # $1 = output file, remaining args = extra `docker run` flags (env settings).
  local out="$1"
  shift
  docker run --rm \
    -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
    -e "CADDY_SITE_ADDRESS=${SITE_ADDRESS}" \
    "$@" \
    "${CADDY_IMAGE}" caddy adapt --config /etc/caddy/Caddyfile \
    > "${out}" 2>"${out}.err"
}

if ! adapt "${TMP_DIR}/empty.json" -e "CADDY_LOCAL_CERTS="; then
  echo "FAIL: Caddyfile does not adapt with CADDY_LOCAL_CERTS empty." >&2
  cat "${TMP_DIR}/empty.json.err" >&2
  exit 1
fi

if ! adapt "${TMP_DIR}/set.json" -e "CADDY_LOCAL_CERTS=local_certs"; then
  echo "FAIL: Caddyfile does not adapt with CADDY_LOCAL_CERTS=local_certs." >&2
  cat "${TMP_DIR}/set.json.err" >&2
  exit 1
fi

if ! adapt "${TMP_DIR}/unset.json"; then
  echo "FAIL: Caddyfile does not adapt with CADDY_LOCAL_CERTS unset." >&2
  cat "${TMP_DIR}/unset.json.err" >&2
  exit 1
fi

python3 - "${TMP_DIR}/empty.json" "${TMP_DIR}/set.json" "${TMP_DIR}/unset.json" <<'PY'
import json
import sys

empty_path, set_path, unset_path = sys.argv[1:4]
with open(empty_path) as fh:
    empty = json.load(fh)
with open(set_path) as fh:
    adapted_set = json.load(fh)
with open(unset_path) as fh:
    unset = json.load(fh)

problems = []

# Guard the guard: a caddy that emitted an empty/degenerate config would satisfy
# every "X is absent" assertion below without proving anything.
routes = (
    empty.get("apps", {})
    .get("http", {})
    .get("servers", {})
)
if not routes:
    problems.append(
        "adapted config for the EMPTY case has no http servers at all; "
        "the adapter produced a degenerate config and these assertions are vacuous"
    )

def issuer_modules(cfg):
    mods = []
    for policy in (
        cfg.get("apps", {})
        .get("tls", {})
        .get("automation", {})
        .get("policies", [])
    ):
        for issuer in policy.get("issuers", []):
            mods.append(issuer.get("module"))
    return mods

if "internal" in issuer_modules(empty):
    problems.append(
        "CADDY_LOCAL_CERTS empty produced an `internal` TLS issuer. "
        "Hosted production and every internet-reachable install share this file "
        "and must stay on the public ACME issuer."
    )

if "internal" not in issuer_modules(adapted_set):
    problems.append(
        "CADDY_LOCAL_CERTS=local_certs did NOT produce an `internal` TLS issuer, "
        "so the opt-in no longer switches Caddy to its own CA and an unreachable "
        "domain still fails its ACME order (ERR_SSL_PROTOCOL_ERROR)."
    )

# The ONLY thing the variable may change is the tls app.
stripped = json.loads(json.dumps(adapted_set))
stripped.get("apps", {}).pop("tls", None)
if stripped != empty:
    problems.append(
        "CADDY_LOCAL_CERTS changed something OTHER than the `tls` app. "
        "It must only select the certificate issuer — never routing, headers, "
        "or reverse-proxy behavior."
    )

if unset != empty:
    problems.append(
        "leaving CADDY_LOCAL_CERTS unset does not adapt identically to setting it "
        "empty; an operator who never defines the variable would get different "
        "behavior from one who defines it blank."
    )

if problems:
    print("FAIL: docker/Caddyfile.prod CADDY_LOCAL_CERTS contract broken:", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    sys.exit(1)

print("checked: empty == unset, set adds only the internal TLS issuer")
PY

echo "OK: CADDY_LOCAL_CERTS is a no-op when empty and switches only the TLS issuer when set."
