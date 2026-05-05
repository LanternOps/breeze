#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "relay-edge-hardening: $*" >&2
  exit 1
}

require_grep() {
  local pattern=$1
  local file=$2
  local message=$3
  grep -Eq -- "$pattern" "$file" || fail "$message"
}

reject_grep() {
  local pattern=$1
  local file=$2
  local message=$3
  if grep -Eq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

for file in docker/turnserver.conf docker-compose.yml deploy/docker-compose.prod.yml; do
  require_grep 'max-bps|--max-bps' "$file" "$file must cap TURN relay bandwidth"
  require_grep 'user-quota|--user-quota' "$file" "$file must include per-user TURN quotas"
  require_grep 'total-quota|--total-quota' "$file" "$file must include total TURN quotas"
  require_grep 'denied-peer-ip=.*10\.0\.0\.0|--denied-peer-ip=10\.0\.0\.0' "$file" "$file must deny private TURN peers"
  require_grep 'denied-peer-ip=.*169\.254\.0\.0|--denied-peer-ip=169\.254\.0\.0' "$file" "$file must deny link-local/metadata TURN peers"
  require_grep 'no-loopback-peers|--no-loopback-peers' "$file" "$file must deny loopback TURN peers"
  require_grep 'no-multicast-peers|--no-multicast-peers' "$file" "$file must deny multicast TURN peers"
done

reject_grep 'trusted_proxies[[:space:]]+static[[:space:]]+private_ranges' docker/Caddyfile.prod \
  "Caddy must not trust all private ranges as proxy hops"
require_grep 'CADDY_TRUSTED_PROXIES' docker/Caddyfile.prod \
  "Caddyfile must use configured trusted proxy CIDRs"
require_grep 'TRUSTED_PROXY_CIDRS' deploy/docker-compose.prod.yml \
  "production API must configure trusted proxy CIDRs"
require_grep 'BREEZE_CLOUDFLARED_IP' deploy/docker-compose.prod.yml \
  "production compose must pin the cloudflared hop"
require_grep 'BREEZE_CADDY_IP' deploy/docker-compose.prod.yml \
  "production compose must pin the Caddy hop"

echo "relay-edge-hardening: ok"
