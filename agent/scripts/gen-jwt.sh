#!/usr/bin/env bash
# Generate a JWT token for Breeze API dev use.
#
# Usage:
#   ./agent/scripts/gen-jwt.sh              # uses defaults from .env
#   ./agent/scripts/gen-jwt.sh <user-email> # lookup user by email
#
# Requires: tsx (from apps/api/node_modules), docker (for psql)
#
# The token is printed to stdout. Pipe or copy as needed:
#   export TOKEN=$(./agent/scripts/gen-jwt.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TSX="$REPO_ROOT/apps/api/node_modules/.bin/tsx"

# Load JWT_SECRET from .env
if [[ -f "$REPO_ROOT/.env" ]]; then
  JWT_SECRET=$(grep -E '^JWT_SECRET=' "$REPO_ROOT/.env" | cut -d= -f2-)
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "ERROR: JWT_SECRET not found in $REPO_ROOT/.env" >&2
  exit 1
fi

if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'pnpm install' in apps/api" >&2
  exit 1
fi

# Find a real user ID — either by email arg or first user in DB
EMAIL="${1:-}"
if [[ -n "$EMAIL" ]]; then
  QUERY="SELECT id, email FROM users WHERE email = '$EMAIL' LIMIT 1;"
else
  QUERY="SELECT id, email FROM users LIMIT 1;"
fi

USER_ROW=$(docker exec breeze-postgres-dev psql -U breeze -d breeze -t -A -F'|' -c "$QUERY" 2>/dev/null || true)

if [[ -z "$USER_ROW" ]]; then
  echo "ERROR: No user found in database (is postgres running?)" >&2
  exit 1
fi

USER_ID=$(echo "$USER_ROW" | cut -d'|' -f1 | xargs)
USER_EMAIL=$(echo "$USER_ROW" | cut -d'|' -f2 | xargs)

echo "Generating JWT for: $USER_EMAIL ($USER_ID)" >&2

"$TSX" -e "
import { SignJWT } from 'jose';
async function main() {
  const secret = new TextEncoder().encode('$JWT_SECRET');
  const token = await new SignJWT({
    sub: '$USER_ID',
    email: '$USER_EMAIL',
    roleId: null,
    orgId: null,
    partnerId: null,
    scope: 'system',
    type: 'access',
    mfa: true
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(secret);
  console.log(token);
}
main();
"
