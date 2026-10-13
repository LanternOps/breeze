#!/usr/bin/env bash
# W00 Task 0.3, plan amendment 2: HTTPS front for browsers that reject `Secure` cookies on
# http://*.localhost. Caddy (`tls internal`) terminates TLS on 127.0.0.1:18443 for
# app.localhost and *.tunnel.localhost and proxies to harness-server.mjs on the host
# (:18080), which sees `X-Forwarded-Proto: https` and builds https://…:18443 origins.
#
#   bash tls-front.sh up     # start (container tunnel-w00-tls)
#   bash tls-front.sh down   # remove it
# Browsers do not trust Caddy's internal CA; the Playwright runner uses ignoreHTTPSErrors.
set -euo pipefail
case "${1:-up}" in
  up)
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/tunnel-w00-tls.XXXXXX")"
    cat > "$WORK/Caddyfile" <<'EOF'
{
	admin off
	skip_install_trust
}
https://app.localhost:18443, https://*.tunnel.localhost:18443 {
	tls internal
	reverse_proxy host.docker.internal:18080
}
EOF
    docker run -d --name tunnel-w00-tls -p 127.0.0.1:18443:18443 \
      -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
    sleep 2
    curl -sk --resolve app.localhost:18443:127.0.0.1 'https://app.localhost:18443/__results?rid=none' && echo " <- tls front up"
    ;;
  down)
    docker rm -f tunnel-w00-tls >/dev/null 2>&1 || true
    ;;
esac
