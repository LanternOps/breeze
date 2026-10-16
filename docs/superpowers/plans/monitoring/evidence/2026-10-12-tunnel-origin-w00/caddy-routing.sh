#!/usr/bin/env bash
# W00 Task 0.2 (plan 2026-10-07-network-proxy-tunnel-origin.md): real Caddy routing
# with forged Host and assertion headers. Local docker only.
#
# Usage (from the repo root):
#   bash docs/superpowers/plans/monitoring/evidence/2026-10-12-tunnel-origin-w00/caddy-routing.sh
#
# It copies docker/Caddyfile.prod to a temp dir, adds the proposed tunnel site block
# (the one W01/W02 Task 10 commits) plus a site-level `request_header -X-Breeze-Tunnel-Site`
# in the app block, runs it in front of a stub that echoes upstream|host|assertion|path,
# probes it, and tears everything down. Every container/network is named tunnel-w00-*.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tunnel-w00-caddy.XXXXXX")"
NET=tunnel-w00-net
CADDY_IMAGE=caddy:2-alpine
CURL_IMAGE=curlimages/curl:8.10.1

cleanup() {
  docker rm -f tunnel-w00-stub tunnel-w00-edge >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- Step 1: scratch Caddyfile = prod + app-block assertion strip + tunnel block ---
# Insert the strip right after the existing site-level client-cert strip lines.
awk '
  { print }
  /^  request_header -X-Breeze-Client-Cert-Serial$/ && !done {
    print "  request_header -X-Breeze-Tunnel-Site"; done = 1
  }
' "$REPO_ROOT/docker/Caddyfile.prod" > "$WORK/Caddyfile"
grep -q '^  request_header -X-Breeze-Tunnel-Site$' "$WORK/Caddyfile" || { echo "strip line not inserted" >&2; exit 1; }

cat >> "$WORK/Caddyfile" <<'EOF'

{$TUNNEL_SITE_ADDRESS:http://tunnel-disabled.invalid} {
	{$TUNNEL_TLS_DIRECTIVE}
	request_header -X-Breeze-Tunnel-Site
	request_header -X-Breeze-Client-Cert-Verified
	request_header -X-Breeze-Client-Cert-Serial
	reverse_proxy api:3001 {
		header_up X-Breeze-Tunnel-Site 1
		header_up -Cf-Client-Cert-Verified
		header_up -Cf-Client-Cert-Serial
		header_up -Cf-Client-Cert-Der-Base64
		header_up -Cf-Client-Cert-Sha256
	}
}
EOF

# --- Step 2: stub upstreams that echo who they are and what they received ---
cat > "$WORK/stub.Caddyfile" <<'EOF'
{
	admin off
	auto_https off
}
:3001 {
	respond "api|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:4321 {
	respond "web|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:4322 {
	respond "portal|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:3002 {
	respond "billing|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
EOF

TSA='http://*.us.breezetunnel.test, http://*.*.us.breezetunnel.test'

echo "== caddy adapt with the launch env (sanity) =="
docker run --rm -e CADDY_SITE_ADDRESS=':80' -e TUNNEL_SITE_ADDRESS="$TSA" \
  -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null \
  | grep -oE '"host":\[[^]]*\]' | sort -u

docker network create "$NET" >/dev/null
docker run -d --name tunnel-w00-stub --network "$NET" \
  --network-alias api --network-alias web --network-alias portal --network-alias billing \
  -v "$WORK/stub.Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
docker run -d --name tunnel-w00-edge --network "$NET" --network-alias edge \
  -e CADDY_SITE_ADDRESS=':80' -e TUNNEL_SITE_ADDRESS="$TSA" \
  -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
sleep 2

# --- Step 3: probes ---
p() {
  local label="$1" host="$2" path="$3"; shift 3
  local out
  out="$(docker run --rm --network "$NET" "$CURL_IMAGE" -s -w ' [%{http_code}]' -H "Host: $host" "$@" "http://edge:80$path")"
  printf '%-48s %s\n' "$label" "$out"
}
T=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test
echo "== probes (label → upstream|host|X-Breeze-Tunnel-Site|path [status]) =="
p "tunnel /"                         "$T" /
p "tunnel /api/v1/auth/me"           "$T" /api/v1/auth/me
p "tunnel /portal/login"             "$T" /portal/login
p "tunnel / + forged assertion"      "$T" / -H 'X-Breeze-Tunnel-Site: forged'
p "tunnel / + forged assertion x2"   "$T" / -H 'X-Breeze-Tunnel-Site: forged' -H 'X-Breeze-Tunnel-Site: 0'
p "tunnel / uppercase host"          "$(echo "$T" | tr a-z A-Z)" /
p "tunnel / trailing-dot host"       "$T." /
p "tunnel / host:80"                 "$T:80" /
p "a.b.<suffix> /"                   "a.b.us.breezetunnel.test" /
p "a.b.c.<suffix> / (3 labels)"      "a.b.c.us.breezetunnel.test" /
p "bare suffix /"                    "us.breezetunnel.test" /
p "app /api/v1/health + forged"      "app.example.test" /api/v1/health -H 'X-Breeze-Tunnel-Site: 1'
p "app / + forged"                   "app.example.test" / -H 'X-Breeze-Tunnel-Site: 1'
p "app /portal/login + forged"       "app.example.test" /portal/login -H 'X-Breeze-Tunnel-Site: 1'
p "app / + X-Forwarded-Host tunnel"  "app.example.test" / -H "X-Forwarded-Host: $T"

# --- Step 4: unset vs empty TUNNEL_SITE_ADDRESS ---
echo "== TUNNEL_SITE_ADDRESS unset =="
docker run --rm -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile 2>&1 >/dev/null | tail -2 || true
docker run --rm -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null | grep -oE '"host":\[[^]]*\]' | sort -u && echo "UNSET: adapt exit 0"
echo "== TUNNEL_SITE_ADDRESS empty =="
set +e
docker run --rm -e TUNNEL_SITE_ADDRESS= -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile > "$WORK/empty.json" 2> "$WORK/empty.err"
rc=$?
set -e
echo "EMPTY: adapt exit $rc"; tail -3 "$WORK/empty.err"
grep -oE '"host":\[[^]]*\]' "$WORK/empty.json" | sort -u || true
grep -oE '"listen":\[[^]]*\]' "$WORK/empty.json" | sort -u || true

# --- Step 5: is the API port published in prod compose? ---
# --no-interpolate: the prod file has required ${VAR:?} values, and plain `config`
# fails on them, which would make an empty grep look like "no ports".
echo "== api ports in deploy/docker-compose.prod.yml =="
(cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.prod.yml config --no-interpolate > "$WORK/prod.yml")
awk '/^  api:/{f=1;print;next} f&&/^  [a-z0-9_-]+:$/{f=0} f' "$WORK/prod.yml" > "$WORK/api.yml"
[ -s "$WORK/api.yml" ] || { echo "api service not found in rendered config" >&2; exit 1; }
grep -nE 'ports:|published|expose|network_mode' "$WORK/api.yml" || echo "api: no ports/published/expose/network_mode keys ($(wc -l < "$WORK/api.yml") lines rendered)"
echo "services publishing ports in the prod file:"; grep -nE '^\s+ports:' "$REPO_ROOT/deploy/docker-compose.prod.yml" || echo "  none"
