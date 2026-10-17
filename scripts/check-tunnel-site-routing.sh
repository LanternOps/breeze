#!/usr/bin/env bash
# scripts/check-tunnel-site-routing.sh
#
# Real-Caddy routing contract for the Network Proxy tunnel site block
# (spec docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md §3).
# Drives docker/Caddyfile.prod through real caddy with forged Host and
# X-Breeze-* headers against stub upstreams that echo
# "<service>|<host>|<tunnel-assertion>|<path>|<x-forwarded-proto>|<cert-verified>|<cert-serial>".
# A missing prerequisite is a hard failure under CI and a skip locally (same
# policy as check-caddyfile-local-certs.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CADDYFILE="${REPO_ROOT}/docker/Caddyfile.prod"
CADDY_IMAGE="${CADDY_IMAGE_REF:-caddy:2-alpine}"
CURL_IMAGE="${CURL_IMAGE_REF:-curlimages/curl:8.10.1}"
SUFFIX="us.breezetunnel.test"
LOOKALIKE="usXbreezetunnel.test" # SUFFIX with its dots replaced; must NOT be refused
TUNNEL_ID="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
NET="breeze-tunnel-routing-$$"

skip_or_fail() {
  if [ -n "${CI:-}" ]; then echo "FAIL: $1" >&2; exit 1; fi
  echo "SKIP: $1"; exit 0
}

# Bound a docker call that can hang on a wedged daemon. GNU `timeout` exists on
# CI ubuntu; macOS may lack it, in which case run unbounded.
tmo() { # tmo <seconds> <command...>
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "${secs}" "$@"; else "$@"; fi
}

command -v docker >/dev/null 2>&1 || skip_or_fail "docker CLI not found"
tmo 60 docker info >/dev/null 2>&1 || skip_or_fail "docker daemon unreachable"

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "${NET}-edge" "${NET}-edge-closed" "${NET}-edge-default" "${NET}-stub" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

ECHO='{host}|{header.X-Breeze-Tunnel-Site}|{path}|{header.X-Forwarded-Proto}|{header.X-Breeze-Client-Cert-Verified}|{header.X-Breeze-Client-Cert-Serial}'
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  printf ':3001 {\n\trespond "api|%s"\n}\n' "${ECHO}"
  printf ':4321 {\n\trespond "web|%s"\n}\n' "${ECHO}"
  printf ':4322 {\n\trespond "portal|%s"\n}\n' "${ECHO}"
  printf ':3002 {\n\trespond "billing|%s"\n}\n' "${ECHO}"
} > "${WORK}/stub.Caddyfile"

tmo 120 docker network create "${NET}" >/dev/null
tmo 120 docker run -d --name "${NET}-stub" --network "${NET}" \
  --network-alias api --network-alias web --network-alias portal --network-alias billing \
  -v "${WORK}/stub.Caddyfile:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null

# start_edge <alias> <admission-mode> [extra docker args...]
# Trust the docker bridge ranges so the probes' X-Forwarded-Proto is forwarded
# (the `trusted_proxies` server option is global, so both blocks share it).
start_edge() {
  local alias="$1" mode="$2"; shift 2
  tmo 120 docker run -d --name "${NET}-${alias}" --network "${NET}" --network-alias "${alias}" \
    -e CADDY_SITE_ADDRESS=':80' \
    -e CADDY_TRUSTED_PROXIES='10.0.0.0/8 172.16.0.0/12 192.168.0.0/16' \
    -e REMOTE_ACCESS_ADMISSION_MODE="${mode}" \
    "$@" \
    -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null
}
TUNNEL_ENV=(-e TUNNEL_SITE_ADDRESS="http://*.${SUFFIX}, http://*.*.${SUFFIX}" -e TUNNEL_HOST_SUFFIX="${SUFFIX}")
start_edge edge open "${TUNNEL_ENV[@]}"
start_edge edge-closed closed "${TUNNEL_ENV[@]}"
start_edge edge-default open # TUNNEL_SITE_ADDRESS and TUNNEL_HOST_SUFFIX unset

EDGE=edge
probe() { # probe <host> <path> [extra curl args...]  (uses $EDGE)
  local host="$1" path="$2"; shift 2
  tmo 60 docker run --rm --network "${NET}" "${CURL_IMAGE}" -s --max-time 5 -H "Host: ${host}" "$@" "http://${EDGE}:80${path}" 2>/dev/null || true
}
# Generous readiness loop: a cold runner pulls images and starts several caddies.
wait_ready() { # wait_ready <alias>
  local ready=0
  EDGE="$1"
  for _ in $(seq 1 90); do
    if [ "$(probe app.example.test /x | cut -d'|' -f1)" = "web" ]; then ready=1; break; fi
    sleep 1
  done
  if [ "${ready}" != 1 ]; then
    echo "FAIL edge '$1' never became ready; logs follow" >&2
    docker logs "${NET}-$1" 2>&1 | tail -20 >&2 || true
    exit 1
  fi
}
wait_ready edge-closed
wait_ready edge-default
wait_ready edge

fail=0
expect() { # expect <label> <expected> <host> <path> [extra curl args...]  (uses $EDGE)
  local label="$1" expected="$2"; shift 2
  local got; got="$(probe "$@")"
  if [ "${got}" = "${expected}" ]; then echo "ok   ${label}"; else echo "FAIL ${label}: expected '${expected}' got '${got}'"; fail=1; fi
}

XFP=(-H "X-Forwarded-Proto: https")
FORGED_TUNNEL=(-H "X-Breeze-Tunnel-Site: 1")
FORGED_CERT=(-H "X-Breeze-Client-Cert-Verified: true" -H "X-Breeze-Client-Cert-Serial: DEADBEEF")
TH="${TUNNEL_ID}.${SUFFIX}"
THU="$(printf '%s' "${TH}" | tr '[:lower:]' '[:upper:]')"
# Echo tail "<xfp>|<verified>|<serial>". Tunnel block: both mTLS headers stripped
# (empty). App block, non-API routes: stripped globally (empty). App block
# `handle @api`: the documented normalization re-derives the pair from the
# VERIFIED Cloudflare result only, so a forged X-Breeze pair (no Cf-Client-Cert-*
# header) arrives as verified=false, serial=empty.
TUN_TAIL="https||"
WEB_TAIL="https||"
API_TAIL="https|false|"

EDGE=edge
expect "tunnel / → api with assertion"            "api|${TH}|1|/|${TUN_TAIL}"               "${TH}" / "${XFP[@]}"
expect "tunnel /api/* → api, never app routing"   "api|${TH}|1|/api/v1/auth/me|${TUN_TAIL}" "${TH}" /api/v1/auth/me "${XFP[@]}"
expect "tunnel /portal/* → api, never portal"     "api|${TH}|1|/portal/login|${TUN_TAIL}"   "${TH}" /portal/login "${XFP[@]}"
expect "tunnel /billing/* → api, never billing"   "api|${TH}|1|/billing/x|${TUN_TAIL}"      "${TH}" /billing/x "${XFP[@]}"
expect "tunnel forged assertion is replaced"      "api|${TH}|1|/|${TUN_TAIL}"               "${TH}" / "${XFP[@]}" -H "X-Breeze-Tunnel-Site: forged"
expect "tunnel strips a forged mTLS assertion pair" "api|${TH}|1|/|${TUN_TAIL}"             "${TH}" / "${XFP[@]}" "${FORGED_CERT[@]}"
expect "tunnel /api/* strips a forged mTLS pair"  "api|${TH}|1|/api/v1/x|${TUN_TAIL}"       "${TH}" /api/v1/x "${XFP[@]}" "${FORGED_CERT[@]}"
expect "deeper tunnel host → api (API 404s it)"   "api|a.b.${SUFFIX}|1|/|${TUN_TAIL}"       "a.b.${SUFFIX}" / "${XFP[@]}"
expect "uppercase tunnel host → api"              "api|${THU}|1|/|${TUN_TAIL}"              "${THU}" / "${XFP[@]}"
expect "tunnel host with explicit :80 → api"      "api|${TH}|1|/|${TUN_TAIL}"               "${TH}:80" / "${XFP[@]}"
expect "app /api strips a forged tunnel assertion" "api|app.example.test||/api/v1/health|${API_TAIL}" app.example.test /api/v1/health "${XFP[@]}" "${FORGED_TUNNEL[@]}"
expect "app / strips a forged tunnel assertion"   "web|app.example.test||/|${WEB_TAIL}"     app.example.test / "${XFP[@]}" "${FORGED_TUNNEL[@]}"
expect "app /portal/* strips a forged tunnel assertion"  "portal|app.example.test||/portal/login|${WEB_TAIL}" app.example.test /portal/login "${XFP[@]}" "${FORGED_TUNNEL[@]}"
expect "app /billing/* strips a forged tunnel assertion" "billing|app.example.test||/billing/x|${WEB_TAIL}"   app.example.test /billing/x "${XFP[@]}" "${FORGED_TUNNEL[@]}"
# mTLS contract on the app host: a forged X-Breeze pair is never trusted.
expect "app /api/v1/health normalizes a forged mTLS pair (false, no serial)" "api|app.example.test||/api/v1/health|${API_TAIL}" app.example.test /api/v1/health "${XFP[@]}" "${FORGED_CERT[@]}"
expect "app / strips a forged mTLS pair"          "web|app.example.test||/|${WEB_TAIL}"     app.example.test / "${XFP[@]}" "${FORGED_CERT[@]}"
# (amended 2026-10-12b, item 6) Both blocks must forward the same
# X-Forwarded-Proto upstream, or FORCE_HTTPS 400s every tunnel request (see the
# Caddyfile header note). Probe a non-default value on each block.
expect "tunnel block forwards X-Forwarded-Proto http" "api|${TH}|1|/|http||" "${TH}" / -H "X-Forwarded-Proto: http"
expect "app block forwards X-Forwarded-Proto http"    "api|app.example.test||/api/x|http|false|" app.example.test /api/x -H "X-Forwarded-Proto: http"

# (amended 2026-10-12b, item 2) Tunnel-domain hosts that miss both wildcards land
# in the :80 app block (W00 contradiction 3). The app block must refuse them at
# the edge; the API classifier (421) is only the backstop.
probe_status() { # probe_status <host> <path>  (uses $EDGE)
  tmo 60 docker run --rm --network "${NET}" "${CURL_IMAGE}" -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $1" "http://${EDGE}:80$2" 2>/dev/null || true
}
expect_status() { # expect_status <label> <expected-code> <host> <path>
  local label="$1" expected="$2"; shift 2
  local got; got="$(probe_status "$@")"
  if [ "${got}" = "${expected}" ]; then echo "ok   ${label}"; else echo "FAIL ${label}: expected status '${expected}' got '${got}'"; fail=1; fi
}
SUFFIXU="$(printf '%s' "${SUFFIX}" | tr '[:lower:]' '[:upper:]')"
expect_status "bare suffix refused at the edge"         421 "${SUFFIX}" /
expect_status "bare suffix with port refused"           421 "${SUFFIX}:8080" /
expect_status "uppercase bare suffix refused"           421 "${SUFFIXU}" /
expect_status "three-label tunnel host refused"         421 "a.b.c.${SUFFIX}" /
expect_status "trailing-dot tunnel host refused"        421 "${TH}." /
expect_status "app host still served"                   200 app.example.test /
# Dots in the suffix are literal: a look-alike with another character in the dot
# positions, or a host that merely contains the suffix text, is an ordinary app host.
expect_status "dot look-alike host not refused"         200 "${LOOKALIKE}" /
expect_status "suffix-as-substring host not refused"    200 "x${SUFFIX}" /
expect_status "suffix-as-prefix host not refused"       200 "${SUFFIX}.example.test" /

# Remote-access cutover barrier (REMOTE_ACCESS_ADMISSION_MODE=closed). The app
# block 503s remote credential issue/consume paths during a pool cutover; the
# tunnel block consumes the same credentials, so it must honour the barrier for
# EVERY path and never reach the upstream. Uses the edge-closed container.
closed_probe() { # closed_probe <host> <path> -> "<body>|<retry-after>|<status>"
  tmo 60 docker run --rm --network "${NET}" "${CURL_IMAGE}" -s --max-time 5 -H "Host: $1" \
    -o - -w '|%header{retry-after}|%{http_code}' "http://edge-closed:80$2" 2>/dev/null || true
}
BARRIER_BODY='{"error":"remote access temporarily unavailable"}'
expect_closed() { # expect_closed <label> <host> <path>
  local got; got="$(closed_probe "$2" "$3")"
  if [ "${got}" = "${BARRIER_BODY}|60|503" ]; then echo "ok   ${1}"; else echo "FAIL ${1}: expected 503 + Retry-After 60 + barrier body, got '${got}'"; fail=1; fi
}
expect_closed "closed: tunnel / → 503, never reaches upstream"            "${TH}" /
expect_closed "closed: tunnel /__bz/enter?t=x → 503, never reaches upstream" "${TH}" '/__bz/enter?t=x'
expect_closed "closed: deeper tunnel host → 503"                          "a.b.${SUFFIX}" /
expect_closed "closed: app /api/v1/tunnel-http/x → 503 (existing barrier)" app.example.test /api/v1/tunnel-http/x
if [ "$(closed_probe app.example.test /x | cut -d'|' -f1)" = "web" ]; then
  echo "ok   closed: unrelated app path still served"
else
  echo "FAIL closed: unrelated app path should still be served"; fail=1
fi

# DEFAULT config (TUNNEL_SITE_ADDRESS and TUNNEL_HOST_SUFFIX unset, as when host
# mode is off): a tunnel-shaped host is just an app host, and the disabled
# placeholder address is the only host the tunnel block answers.
EDGE=edge-default
expect "default: tunnel-shaped host → app block (web), no assertion" "web|${TH}||/|${WEB_TAIL}" "${TH}" / "${XFP[@]}"
expect "default: tunnel-shaped host with forged assertion → still none" "web|${TH}||/|${WEB_TAIL}" "${TH}" / "${XFP[@]}" "${FORGED_TUNNEL[@]}"
expect "default: tunnel-disabled.invalid → api with assertion (only tunnel match)" "api|tunnel-disabled.invalid|1|/|${TUN_TAIL}" tunnel-disabled.invalid / "${XFP[@]}"
expect_status "default: tunnel-shaped host is not refused"  200 "${TH}" /
expect_status "default: bare suffix is not refused"         200 "${SUFFIX}" /

# (amended 2026-10-12b, item 3) Empty TUNNEL_* vars break `caddy adapt` or turn
# the matcher into "any trailing-dot host"; compose must default each with `:-`
# so set-but-empty also gets the default.
for v in 'TUNNEL_SITE_ADDRESS:-http://tunnel-disabled.invalid' 'TUNNEL_HOST_SUFFIX:-tunnel-disabled.invalid' 'TUNNEL_TLS_DIRECTIVE:-}'; do
  for f in "${REPO_ROOT}/docker-compose.yml" "${REPO_ROOT}/deploy/docker-compose.prod.yml"; do
    if grep -qF "\${${v}" "$f"; then
      echo "ok   $(basename "$f") defaults ${v%%:-*} with :-"
    else
      echo "FAIL $(basename "$f") must pass \${${v}"; fail=1
    fi
  done
done

# Disabled default: with the tunnel vars unset the file must still adapt.
if tmo 120 docker run --rm -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" caddy adapt --config /etc/caddy/Caddyfile >/dev/null; then
  echo "ok   adapts with TUNNEL_SITE_ADDRESS unset"
else
  echo "FAIL adapt with TUNNEL_SITE_ADDRESS unset"; fail=1
fi

exit "${fail}"
