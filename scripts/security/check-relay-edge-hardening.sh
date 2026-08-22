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
  require_grep 'denied-peer-ip=.*127\.0\.0\.0|--denied-peer-ip=127\.0\.0\.0' "$file" "$file must deny IPv4 loopback TURN peers"
  require_grep 'denied-peer-ip=.*::1|--denied-peer-ip=::1' "$file" "$file must deny IPv6 loopback TURN peers"
  require_grep 'no-multicast-peers|--no-multicast-peers' "$file" "$file must deny multicast TURN peers"
done

# SR-009: coturn must fail closed if TURN_SECRET is unset/empty. An empty REST
# shared secret makes TURN credentials trivially forgeable (open relay).
#
# This check used to require the interpolation-time `${TURN_SECRET:?...}` form.
# That did fail closed, but it failed closed for EVERYBODY: Compose interpolates
# the entire file before it filters by profile, so a `:?` inside the profiled
# coturn service aborted `docker compose up` for every self-hoster, TURN or not.
# It was the first error every new install hit.
#
# The guarantee is now enforced at container start instead, and the secret is
# delivered as a file-backed Compose secret rather than argv — strictly stronger
# than before, since the old form exposed it via /proc/<pid>/cmdline to anything
# running in the container.
#
# Assertions are scoped to the coturn service block, because a repo-wide grep can
# be satisfied by a comment or an unrelated service and would pass vacuously.
# coturn is the LAST service in both files, so the block must terminate on a
# top-level key (`networks:`, `volumes:`, `secrets:`) as well as on a sibling
# service — otherwise it swallows the rest of the file and the assertions below
# can be satisfied by unrelated sections.
coturn_block() {
  awk '
    /^  coturn:/ { inblk = 1; next }
    inblk && /^[^[:space:]]/ { exit }
    inblk && /^  [a-z_-]+:/ { exit }
    inblk
  ' "$1"
}

# YAML comments are prose, not configuration: the notes explaining this very rule
# quote the forbidden `${TURN_SECRET:?...}` form. Strip them before asserting.
without_comments() {
  sed 's/[[:space:]]*#.*$//' "$1"
}

for file in docker-compose.yml deploy/docker-compose.prod.yml; do
  blk="$(mktemp)"
  code="$(mktemp)"
  coturn_block "$file" > "$blk"
  without_comments "$file" > "$code"
  [ -s "$blk" ] || fail "$file: could not locate the coturn service block (did it get renamed?)"

  # 1a. No `:?` form anywhere in the file. Compose evaluates every interpolation
  #     before it filters by profile, so a single required-variable reference --
  #     even inside a service nobody enables -- aborts `docker compose up` for
  #     every deployment. This is the exact regression being guarded against.
  #     (`${TURN_SECRET:-}` is fine and is how the api service receives it, so
  #     that it can mint REST credentials for WebRTC clients.)
  reject_grep '\$\{TURN_SECRET:\?' "$code" \
    "$file: TURN_SECRET must not use the required-variable form \${TURN_SECRET:?...}. Compose interpolates the whole file before filtering by profile, so this aborts 'docker compose up' for every deployment that does not use TURN. Use \${TURN_SECRET:-} and let coturn fail closed at startup."

  # 1b. The coturn service itself must not interpolate the secret at all -- it
  #     receives it as a file-backed secret.
  blk_code="$(mktemp)"
  sed 's/[[:space:]]*#.*$//' "$blk" > "$blk_code"
  reject_grep '\$\{TURN_SECRET' "$blk_code" \
    "$file: the coturn service must not interpolate \${TURN_SECRET...}; it reads /run/secrets/turn_secret instead"
  rm -f "$blk_code"

  # 2. It must reach coturn as a secret file, not argv or the environment.
  require_grep '^      - turn_secret$' "$blk" \
    "$file: the coturn service must mount the turn_secret Compose secret"
  require_grep '^  turn_secret:' "$file" \
    "$file: a turn_secret Compose secret must be declared"
  # The FLAG form is what leaks into argv. The `static-auth-secret=` config-file
  # key written from /run/secrets is the intended path, so match only `--`.
  reject_grep '\-\-static-auth-secret=' "$blk" \
    "$file: the TURN shared secret must not be passed on coturn's command line (readable via /proc/<pid>/cmdline); write it to a 0600 config file from /run/secrets/turn_secret instead"

  # 3. It must refuse to start on a missing/empty secret, BEFORE exec'ing
  #    turnserver -- this is the fail-closed guarantee itself.
  require_grep '\[ ! -s /run/secrets/turn_secret \]' "$blk" \
    "$file: coturn must refuse to start when /run/secrets/turn_secret is missing or empty (open-relay risk)"
  require_grep 'exit 1' "$blk" \
    "$file: coturn's empty-secret check must exit non-zero"
  require_grep 'umask 077' "$blk" \
    "$file: the generated coturn secret config must be written with a restrictive umask"
  require_grep 'exec turnserver -c /tmp/turn-secret\.conf' "$blk" \
    "$file: coturn must exec turnserver with the generated secret config"

  # 4. The auth mode that makes the secret meaningful must still be on.
  require_grep '^      - --use-auth-secret$' "$blk" \
    "$file: coturn must keep --use-auth-secret (REST shared-secret authentication)"

  rm -f "$blk" "$code"
done

# Behavioral proof of the property this check exists for: with TURN_SECRET unset,
# the compose file must still resolve. Requires Docker, so it is advisory when the
# CLI is unavailable (the structural assertions above always run).
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  probe="$(mktemp -d)"
  # Only coturn is under test; a stub keeps the probe independent of the many
  # other required variables in the real file.
  {
    echo 'services:'
    echo '  coturn:'
    coturn_block docker-compose.yml
    echo 'secrets:'
    echo '  turn_secret:'
    echo '    environment: TURN_SECRET'
  } > "$probe/docker-compose.yml"

  if ! (cd "$probe" && env -u TURN_SECRET COTURN_IMAGE_REF=coturn/coturn:latest \
        docker compose config >/dev/null 2>"$probe/err"); then
    echo "relay-edge-hardening: coturn config failed to resolve with TURN_SECRET unset:" >&2
    cat "$probe/err" >&2
    rm -rf "$probe"
    fail "TURN_SECRET must not be required to bring up a stack that does not use TURN"
  fi
  rm -rf "$probe"
fi

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
