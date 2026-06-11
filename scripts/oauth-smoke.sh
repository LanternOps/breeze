#!/usr/bin/env bash
set -euo pipefail

# OAuth 2.1 + DCR + PKCE smoke test against a live Breeze API instance.
#
# Covers Tasks 13 and 17 of the MCP OAuth implementation plan
# (internal/mcp-bootstrap/plans/2026-04-23-mcp-oauth-implementation.md).
#
# What this script does WITHOUT user interaction (rerunnable in CI / locally):
#   1. GET /.well-known/oauth-authorization-server — discovery doc shape
#   2. GET /.well-known/oauth-protected-resource    — resource metadata
#   3. GET /.well-known/jwks.json                   — JWKS contains EdDSA keys,
#                                                     no private fields
#   4. POST /oauth/reg                              — DCR returns client_id
#   5. PUT /oauth/reg/:client_id                    — registrationManagement
#   6. GET  /oauth/auth (no auth)                   — redirects to consent UI
#                                                     (interactionDetails works)
#   7. POST /oauth/token (bad code)                 — invalid_grant 400
#   8. Bearer auth on /api/v1/mcp/message with junk → 401
#
# What this script CANNOT do without a logged-in browser session:
#   - Exchange an authorization code for an access token
#   - Hit the consent backend (requires dashboard JWT cookie)
#   - Verify the round-trip JWT call against /mcp/server with mcp:read scope
# These pieces are covered by the Vitest integration test
# (apps/api/src/__tests__/integration/oauth-code-flow.integration.test.ts) and
# by the Playwright/manual flow documented at the bottom of this file.
#
# Requires: curl, jq, openssl, python3 (for base64url + sha256 helpers).

usage() {
  cat <<'EOF'
Usage: scripts/oauth-smoke.sh [--base URL] [--keep-client] [--help]

Options:
  --base URL       Base URL of the API to test (default: http://localhost:3001)
  --keep-client    Don't issue PUT /oauth/reg/:id update + don't print "delete me" hint.
  --help           Show this message.

Env overrides:
  OAUTH_SMOKE_BASE   same as --base
  OAUTH_REDIRECT_URI redirect_uri to register (default: http://localhost:3000/cb)
  CLIENT_NAME        client_name for DCR (default: oauth-smoke)
  CURL_FLAGS         extra curl flags (e.g. "-k" to skip TLS verify)

Exit codes:
  0  all probes passed
  1  any probe failed (look at last log line)
EOF
}

BASE="${OAUTH_SMOKE_BASE:-http://localhost:3001}"
REDIRECT_URI="${OAUTH_REDIRECT_URI:-http://localhost:3000/cb}"
CLIENT_NAME="${CLIENT_NAME:-oauth-smoke}"
KEEP_CLIENT=0
CURL_FLAGS="${CURL_FLAGS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --keep-client) KEEP_CLIENT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

for cmd in curl jq openssl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' not on PATH" >&2
    exit 1
  fi
done

# shellcheck disable=SC2086
CURL="curl -sS $CURL_FLAGS"
PASS=0
FAIL=0

ok()   { echo "  ok      — $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL    — $*"; FAIL=$((FAIL + 1)); }
note() { echo "  note    — $*"; }

step() { printf '\n→ %s\n' "$*"; }

b64url_sha256() {
  python3 - <<'PY'
import base64, hashlib, sys
v = sys.stdin.buffer.read()
d = hashlib.sha256(v).digest()
sys.stdout.write(base64.urlsafe_b64encode(d).rstrip(b"=").decode())
PY
}

step "1. /.well-known/oauth-authorization-server"
DISC="$($CURL "$BASE/.well-known/oauth-authorization-server")"
echo "$DISC" | jq . >/dev/null 2>&1 && ok "valid JSON" || fail "not JSON: $DISC"
ISSUER="$(echo "$DISC" | jq -r '.issuer // empty')"
[[ -n "$ISSUER" ]] && ok "issuer: $ISSUER" || fail "issuer missing"
for key in authorization_endpoint token_endpoint registration_endpoint revocation_endpoint introspection_endpoint jwks_uri; do
  v="$(echo "$DISC" | jq -r --arg k "$key" '.[$k] // empty')"
  [[ -n "$v" ]] && ok "$key present" || fail "$key missing"
done
echo "$DISC" | jq -e '.code_challenge_methods_supported | index("S256")' >/dev/null \
  && ok "S256 PKCE advertised" || fail "S256 PKCE not advertised"
echo "$DISC" | jq -e '.grant_types_supported | index("authorization_code") and (. | index("refresh_token"))' >/dev/null \
  && ok "code + refresh grant types" || fail "missing grant types"
echo "$DISC" | jq -e '.scopes_supported | index("mcp:read") and (. | index("mcp:write"))' >/dev/null \
  && ok "mcp:read + mcp:write advertised" || fail "mcp scopes missing"

step "2. /.well-known/oauth-protected-resource"
PR="$($CURL "$BASE/.well-known/oauth-protected-resource")"
echo "$PR" | jq -e '.resource and .authorization_servers' >/dev/null \
  && ok "resource + authorization_servers present" || fail "shape wrong: $PR"
RESOURCE="$(echo "$PR" | jq -r '.resource')"
note "resource indicator: $RESOURCE"

step "3. /.well-known/jwks.json"
JWKS="$($CURL "$BASE/.well-known/jwks.json")"
KEYS_LEN="$(echo "$JWKS" | jq '.keys | length')"
[[ "$KEYS_LEN" -gt 0 ]] && ok "jwks has $KEYS_LEN key(s)" || fail "no keys"
echo "$JWKS" | jq -e '.keys[] | select(.alg == "EdDSA")' >/dev/null \
  && ok "EdDSA key present" || fail "no EdDSA key"
PRIV_LEAK="$(echo "$JWKS" | jq -r '.keys[] | [.d,.p,.q] | map(select(. != null)) | length' | head -1)"
[[ "$PRIV_LEAK" == "0" || -z "$PRIV_LEAK" ]] && ok "no private fields leaked" || fail "PRIVATE FIELDS in JWKS!"

step "4. POST /oauth/reg (Dynamic Client Registration)"
REG_BODY="$(jq -nc \
  --arg name "$CLIENT_NAME" \
  --arg uri "$REDIRECT_URI" \
  '{client_name: $name, redirect_uris: [$uri], grant_types: ["authorization_code","refresh_token"], response_types:["code"], token_endpoint_auth_method:"none", scope:"openid offline_access mcp:read mcp:write", id_token_signed_response_alg:"EdDSA"}')"
REG="$($CURL -X POST -H 'Content-Type: application/json' -d "$REG_BODY" "$BASE/oauth/reg")"
CLIENT_ID="$(echo "$REG" | jq -r '.client_id // empty')"
if [[ -n "$CLIENT_ID" ]]; then
  ok "DCR returned client_id: $CLIENT_ID"
else
  fail "DCR failed: $REG"
fi
RAT="$(echo "$REG" | jq -r '.registration_access_token // empty')"
[[ -n "$RAT" ]] && ok "registration_access_token issued" || note "no registration_access_token (registrationManagement off?)"

step "5. PUT /oauth/reg/:client_id (registrationManagement)"
if [[ -n "$CLIENT_ID" && -n "$RAT" ]]; then
  UPD_BODY="$(jq -nc \
    --arg id "$CLIENT_ID" \
    --arg name "${CLIENT_NAME}-renamed" \
    --arg uri "$REDIRECT_URI" \
    '{client_id:$id, client_name: $name, redirect_uris: [$uri], grant_types: ["authorization_code","refresh_token"], response_types:["code"], token_endpoint_auth_method:"none", scope:"openid offline_access mcp:read mcp:write", id_token_signed_response_alg:"EdDSA"}')"
  UPD="$($CURL -X PUT -H 'Content-Type: application/json' -H "Authorization: Bearer $RAT" -d "$UPD_BODY" "$BASE/oauth/reg/$CLIENT_ID")"
  if echo "$UPD" | jq -e --arg n "${CLIENT_NAME}-renamed" '.client_name == $n' >/dev/null; then
    ok "registrationManagement update applied"
  else
    fail "PUT /oauth/reg failed: $UPD"
  fi
else
  note "skipping (no client_id / RAT)"
fi

step "6. GET /oauth/auth (anonymous) — should 302 to consent UI"
VERIFIER="$(openssl rand -base64 64 | tr -d '=+/' | head -c 64)"
CHALLENGE="$(printf '%s' "$VERIFIER" | b64url_sha256)"
AUTH_URL="$BASE/oauth/auth?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid%20offline_access%20mcp%3Aread%20mcp%3Awrite&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=$RESOURCE&state=smoke"
HTTP_CODE_AND_LOC="$($CURL -o /dev/null -D - -w '%{http_code}' "$AUTH_URL" 2>/dev/null | tr -d '\r')"
HTTP_CODE="$(echo "$HTTP_CODE_AND_LOC" | tail -n 1)"
LOCATION="$(echo "$HTTP_CODE_AND_LOC" | grep -i '^location:' | head -1 | awk '{print $2}')"
if [[ "$HTTP_CODE" == "302" || "$HTTP_CODE" == "303" ]]; then
  ok "anonymous /oauth/auth returns $HTTP_CODE (login/consent redirect)"
else
  fail "expected 302/303 from /oauth/auth, got $HTTP_CODE"
fi
[[ -n "$LOCATION" ]] && ok "Location header present: $(echo "$LOCATION" | cut -c1-80)…" \
  || fail "no Location header on redirect"

step "7. POST /oauth/token with bad code → invalid_grant"
TOK_BAD="$($CURL -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=not-a-real-code&client_id=$CLIENT_ID&code_verifier=$VERIFIER&redirect_uri=$REDIRECT_URI" \
  "$BASE/oauth/token" || true)"
ERR_KIND="$(echo "$TOK_BAD" | jq -r '.error // empty')"
if [[ "$ERR_KIND" == "invalid_grant" || "$ERR_KIND" == "invalid_request" ]]; then
  ok "/oauth/token returned $ERR_KIND for bad code"
else
  fail "expected invalid_grant from /oauth/token, got: $TOK_BAD"
fi

step "8. /api/v1/mcp/message with junk Bearer → 401"
HTTP_CODE="$($CURL -o /tmp/oauth-smoke-mcp.json -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer not.a.jwt' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$BASE/api/v1/mcp/message" || true)"
if [[ "$HTTP_CODE" == "401" ]]; then
  ok "MCP endpoint returns 401 on junk bearer"
else
  fail "expected 401 from MCP, got $HTTP_CODE: $(cat /tmp/oauth-smoke-mcp.json 2>/dev/null | head -c 200)"
fi

# ---- summary ----
echo
echo "── summary ────────────────────────────────────────────────"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if [[ "$KEEP_CLIENT" -eq 0 && -n "$CLIENT_ID" ]]; then
  echo
  echo "  Test client persisted as $CLIENT_ID. Delete with:"
  echo "    docker exec breeze-postgres psql -U breeze -d breeze -c \\"
  echo "      \"UPDATE oauth_clients SET disabled_at = now() WHERE id = '$CLIENT_ID';\""
fi

cat <<'EOF'

── manual portion (Task 17) ────────────────────────────────
The unauthenticated portions of the OAuth surface are now verified.
The full code-flow round-trip (register → authorize → consent → token →
MCP call → revoke) requires a logged-in browser session and is covered by:

  apps/api/src/__tests__/integration/oauth-code-flow.integration.test.ts

To exercise the consent UI by hand against the local stack:
  1. docker compose up -d     # ensure API + web are running
  2. Open in a browser (replace CLIENT_ID below):
EOF
echo "       $AUTH_URL"
cat <<'EOF'
  3. Sign in with a Breeze dashboard user
  4. On the consent page, pick a partner and click Approve
  5. The browser will redirect to redirect_uri with ?code=<...>
  6. Exchange the code for a token:
       curl -sS BASE/oauth/token \
         -d grant_type=authorization_code -d code=<CODE> \
         -d client_id=CLIENT_ID -d code_verifier=VERIFIER \
         -d redirect_uri=REDIRECT_URI -d resource=RESOURCE | jq
EOF

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
