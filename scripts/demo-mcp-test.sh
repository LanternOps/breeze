#!/usr/bin/env bash
set -euo pipefail

# Run the MCP bootstrap E2E test against the local docker stack.
#
# Defaults to hitting the API directly at http://localhost:3001 because the
# /test/activate and /test/complete-payment shortcut routes are NOT proxied by
# Caddy (Caddyfile.dev only forwards /api/*, /s/*, etc), so going through
# https://2breeze.app would 404 those steps.
#
# Override with BASE_URL=https://your.host if you've added /test/* to Caddy.

usage() {
  cat <<'EOF'
Usage: scripts/demo-mcp-test.sh [--help]

Environment:
  BASE_URL   API base URL for the test (default: http://localhost:3001)
             Must point at the API directly OR a proxy that forwards /test/*.
  KEEP_TEST_MODE=1
             Skip restoring MCP_BOOTSTRAP_TEST_MODE on exit (leaves it true).

What it does:
  1. Verifies docker + breeze-api are running
  2. Flips MCP_BOOTSTRAP_TEST_MODE=true in .env if needed (restores on exit)
  3. Restarts breeze-api so the env change takes effect
  4. Runs e2e-tests/tests/mcp_bootstrap.yaml via tsx
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
BASE_URL="${BASE_URL:-http://localhost:3001}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker CLI not found in PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon is not running" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q '^breeze-api$'; then
  echo "error: breeze-api container is not running. Start your stack first:" >&2
  echo "  docker compose up -d" >&2
  exit 1
fi

# Capture original value (default to "false" if unset) so we can restore it.
ORIGINAL_LINE="$(grep -E '^MCP_BOOTSTRAP_TEST_MODE=' "$ENV_FILE" || true)"
ORIGINAL_VALUE="${ORIGINAL_LINE#MCP_BOOTSTRAP_TEST_MODE=}"
if [[ -z "$ORIGINAL_LINE" ]]; then
  ORIGINAL_VALUE="<unset>"
fi

NEEDS_FLIP=0
if [[ "$ORIGINAL_VALUE" != "true" ]]; then
  NEEDS_FLIP=1
fi

restore_env() {
  local exit_code=$?
  if [[ "${KEEP_TEST_MODE:-0}" == "1" ]]; then
    echo "» KEEP_TEST_MODE=1 set — leaving MCP_BOOTSTRAP_TEST_MODE=true in .env"
    exit "$exit_code"
  fi
  if [[ "$NEEDS_FLIP" == "1" ]]; then
    echo "» Restoring MCP_BOOTSTRAP_TEST_MODE in .env"
    if [[ "$ORIGINAL_VALUE" == "<unset>" ]]; then
      # Remove the line we added.
      # BSD sed (macOS) requires the empty-string -i argument.
      sed -i '' '/^MCP_BOOTSTRAP_TEST_MODE=/d' "$ENV_FILE"
    else
      sed -i '' "s|^MCP_BOOTSTRAP_TEST_MODE=.*|MCP_BOOTSTRAP_TEST_MODE=${ORIGINAL_VALUE}|" "$ENV_FILE"
    fi
    echo "» Restarting breeze-api to pick up restored env"
    docker restart breeze-api >/dev/null
  fi
  exit "$exit_code"
}
trap restore_env EXIT

if [[ "$NEEDS_FLIP" == "1" ]]; then
  echo "» MCP_BOOTSTRAP_TEST_MODE was '$ORIGINAL_VALUE' — flipping to 'true' for this run"
  if [[ -z "$ORIGINAL_LINE" ]]; then
    printf '\nMCP_BOOTSTRAP_TEST_MODE=true\n' >> "$ENV_FILE"
  else
    sed -i '' 's|^MCP_BOOTSTRAP_TEST_MODE=.*|MCP_BOOTSTRAP_TEST_MODE=true|' "$ENV_FILE"
  fi
  echo "» Restarting breeze-api so it reads the new env"
  docker restart breeze-api >/dev/null

  # Wait for /health to come back up. Compose health timeouts are 30s; allow 60.
  echo -n "» Waiting for breeze-api /health "
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:3001/health" >/dev/null 2>&1; then
      echo "ok"
      break
    fi
    echo -n "."
    sleep 1
  done
  if ! curl -fsS "http://localhost:3001/health" >/dev/null 2>&1; then
    echo
    echo "error: breeze-api did not become healthy in 60s" >&2
    exit 1
  fi
else
  echo "» MCP_BOOTSTRAP_TEST_MODE already 'true' — no env flip needed"
fi

echo "» Running mcp-bootstrap spec against $BASE_URL"
cd "$REPO_ROOT/e2e-tests"
E2E_API_URL="$BASE_URL" \
E2E_BASE_URL="$BASE_URL" \
MCP_BOOTSTRAP_ENABLED=true \
MCP_BOOTSTRAP_TEST_MODE=true \
  pnpm test tests/mcp-bootstrap.spec.ts
