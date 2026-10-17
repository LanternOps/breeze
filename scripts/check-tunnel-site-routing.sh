#!/usr/bin/env bash
# scripts/check-tunnel-site-routing.sh
#
# Real-Caddy routing contract for the Network Proxy tunnel site block
# (spec docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md §3).
# Drives docker/Caddyfile.prod through real caddy with forged Host and
# X-Breeze-Tunnel-Site headers against stub upstreams that echo
# "<service>|<host>|<assertion>|<path>|<x-forwarded-proto>". A missing
# prerequisite is a hard failure under CI and a skip locally (same policy as
# check-caddyfile-local-certs.sh).
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
command -v docker >/dev/null 2>&1 || skip_or_fail "docker CLI not found"
docker info >/dev/null 2>&1 || skip_or_fail "docker daemon unreachable"

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "${NET}-edge" "${NET}-edge-closed" "${NET}-stub" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

ECHO='{host}|{header.X-Breeze-Tunnel-Site}|{path}|{header.X-Forwarded-Proto}'
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  printf ':3001 {\n\trespond "api|%s"\n}\n' "${ECHO}"
  printf ':4321 {\n\trespond "web|%s"\n}\n' "${ECHO}"
  printf ':4322 {\n\trespond "portal|%s"\n}\n' "${ECHO}"
  printf ':3002 {\n\trespond "billing|%s"\n}\n' "${ECHO}"
} > "${WORK}/stub.Caddyfile"

docker network create "${NET}" >/dev/null
docker run -d --name "${NET}-stub" --network "${NET}" \
  --network-alias api --network-alias web --network-alias portal --network-alias billing \
  -v "${WORK}/stub.Caddyfile:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null
# Trust the docker bridge ranges so the probes' X-Forwarded-Proto is forwarded
# (the `trusted_proxies` server option is global, so both blocks share it).
docker run -d --name "${NET}-edge" --network "${NET}" --network-alias edge \
  -e CADDY_SITE_ADDRESS=':80' \
  -e CADDY_TRUSTED_PROXIES='10.0.0.0/8 172.16.0.0/12 192.168.0.0/16' \
  -e REMOTE_ACCESS_ADMISSION_MODE=open \
  -e TUNNEL_SITE_ADDRESS="http://*.${SUFFIX}, http://*.*.${SUFFIX}" \
  -e TUNNEL_HOST_SUFFIX="${SUFFIX}" \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null

probe() { # probe <host> <path> [extra curl args...]
  local host="$1" path="$2"; shift 2
  docker run --rm --network "${NET}" "${CURL_IMAGE}" -s --max-time 5 -H "Host: ${host}" "$@" "http://edge:80${path}"
}
# Generous readiness loop: a cold runner pulls images and starts two caddies.
ready=0
for _ in $(seq 1 90); do
  if [ "$(probe app.example.test /x 2>/dev/null | cut -d'|' -f1)" = "web" ]; then ready=1; break; fi
  sleep 1
done
if [ "${ready}" != 1 ]; then
  echo "FAIL edge caddy never became ready; logs follow" >&2
  docker logs "${NET}-edge" 2>&1 | tail -20 >&2 || true
  exit 1
fi

fail=0
expect() { # expect <label> <expected> <host> <path> [extra curl args...]
  local label="$1" expected="$2"; shift 2
  local got; got="$(probe "$@")"
  if [ "${got}" = "${expected}" ]; then echo "ok   ${label}"; else echo "FAIL ${label}: expected '${expected}' got '${got}'"; fail=1; fi
}

XFP=(-H "X-Forwarded-Proto: https")
TH="${TUNNEL_ID}.${SUFFIX}"
THU="$(printf '%s' "${TH}" | tr '[:lower:]' '[:upper:]')"
expect "tunnel / → api with assertion"            "api|${TH}|1|/|https"                  "${TH}" / "${XFP[@]}"
expect "tunnel /api/* → api, never app routing"   "api|${TH}|1|/api/v1/auth/me|https"    "${TH}" /api/v1/auth/me "${XFP[@]}"
expect "tunnel /portal/* → api, never portal"     "api|${TH}|1|/portal/login|https"      "${TH}" /portal/login "${XFP[@]}"
expect "tunnel /billing/* → api, never billing"   "api|${TH}|1|/billing/x|https"         "${TH}" /billing/x "${XFP[@]}"
expect "tunnel forged assertion is replaced"      "api|${TH}|1|/|https"                  "${TH}" / "${XFP[@]}" -H "X-Breeze-Tunnel-Site: forged"
expect "deeper tunnel host → api (API 404s it)"   "api|a.b.${SUFFIX}|1|/|https"          "a.b.${SUFFIX}" / "${XFP[@]}"
expect "uppercase tunnel host → api"              "api|${THU}|1|/|https"                 "${THU}" / "${XFP[@]}"
expect "tunnel host with explicit :80 → api"      "api|${TH}|1|/|https"                  "${TH}:80" / "${XFP[@]}"
expect "app /api strips a forged assertion"       "api|app.example.test||/api/v1/health|https" app.example.test /api/v1/health "${XFP[@]}" -H "X-Breeze-Tunnel-Site: 1"
expect "app / strips a forged assertion"          "web|app.example.test||/|https"        app.example.test / "${XFP[@]}" -H "X-Breeze-Tunnel-Site: 1"
# (amended 2026-10-12b, item 6) Both blocks must forward the same
# X-Forwarded-Proto upstream, or FORCE_HTTPS 400s every tunnel request (see the
# Caddyfile header note). Probe a non-default value on each block.
expect "tunnel block forwards X-Forwarded-Proto http" "api|${TH}|1|/|http" "${TH}" / -H "X-Forwarded-Proto: http"
expect "app block forwards X-Forwarded-Proto http"    "api|app.example.test||/api/x|http" app.example.test /api/x -H "X-Forwarded-Proto: http"

# (amended 2026-10-12b, item 2) Tunnel-domain hosts that miss both wildcards land
# in the :80 app block (W00 contradiction 3). The app block must refuse them at
# the edge; the API classifier (421) is only the backstop.
probe_status() { # probe_status <host> <path>
  docker run --rm --network "${NET}" "${CURL_IMAGE}" -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $1" "http://edge:80$2"
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
# EVERY path and never reach the upstream. Second edge, same config, mode closed.
docker run -d --name "${NET}-edge-closed" --network "${NET}" --network-alias edge-closed \
  -e CADDY_SITE_ADDRESS=':80' \
  -e CADDY_TRUSTED_PROXIES='10.0.0.0/8 172.16.0.0/12 192.168.0.0/16' \
  -e REMOTE_ACCESS_ADMISSION_MODE=closed \
  -e TUNNEL_SITE_ADDRESS="http://*.${SUFFIX}, http://*.*.${SUFFIX}" \
  -e TUNNEL_HOST_SUFFIX="${SUFFIX}" \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null
closed_probe() { # closed_probe <host> <path> -> "<status>|<retry-after>|<body>"
  docker run --rm --network "${NET}" "${CURL_IMAGE}" -s --max-time 5 -H "Host: $1" \
    -o - -w '|%header{retry-after}|%{http_code}' "http://edge-closed:80$2" 2>/dev/null || true
}
for _ in $(seq 1 90); do
  case "$(closed_probe app.example.test /x)" in *'|200') break ;; esac
  sleep 1
done
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
if docker run --rm -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" caddy adapt --config /etc/caddy/Caddyfile >/dev/null; then
  echo "ok   adapts with TUNNEL_SITE_ADDRESS unset"
else
  echo "FAIL adapt with TUNNEL_SITE_ADDRESS unset"; fail=1
fi

exit "${fail}"
