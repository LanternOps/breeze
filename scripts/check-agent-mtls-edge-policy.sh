#!/usr/bin/env bash
#
# check-agent-mtls-edge-policy.sh — Wave 5 Task 7 (security remediation).
#
# Pins the EXACT agent mTLS protected route set and the edge assertion
# normalization contract across the three places that must agree on it:
#   - docker/Caddyfile.prod              (the @agentMtlsProtected matcher +
#                                          the header_up normalization block)
#   - docs/operations/cloudflare-mtls-setup.md   (operator runbook)
#   - apps/docs/src/content/docs/security/mtls.mdx  (public docs site)
#
# Spec: .superpowers/sdd/2026-07-23-security-remediation-wave-05-mtls-transport/task-7-brief.md
#
# Protected set (must appear literally, not merely "equivalently", in all
# three files):
#   - REST identity:   ^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$
#   - confirmation:    /api/v1/agents/renew-cert/confirm   (exact)
#   - command WS:      ^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$
#
# Exact exemptions (never a `contains` / `/renew-cert*` broad match):
#   /api/v1/agents/enroll, /api/v1/agents/renew-cert, /api/v1/agents/renew-cert/challenge
#
# Caddy edge normalization (docker/Caddyfile.prod only):
#   1. discard inbound X-Breeze-Client-Cert-Verified / -Serial
#   2. discard raw provider certificate headers from untrusted upstreams
#   3. set the two Breeze headers only from a verified result (never a raw
#      passthrough of a client-supplied Breeze header)
#   4. never forward client certificate PEM/DER/private material
#
# This script runs its own logic against small in-memory fixtures FIRST (a
# "good" case that must pass and several "bad" cases that must fail) so a
# future edit that weakens the grep patterns below is itself caught, before
# ever touching the real repo files. Only after the self-test passes does it
# check the actual tracked files.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CADDYFILE="docker/Caddyfile.prod"
OPS_DOC="docs/operations/cloudflare-mtls-setup.md"
PUBLIC_DOC="apps/docs/src/content/docs/security/mtls.mdx"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# Fixed-string (non-regex) containment check — most of our patterns are
# literal text that itself contains ERE metacharacters ([, ], (, ), ?, $, ^),
# so grep -F is the correct tool; using -E here would silently test the wrong
# thing.
require_fixed() {
  local pattern="$1" file="$2" message="$3"
  grep -Fq -- "$pattern" "$file" || fail "$message"
}

reject_fixed() {
  local pattern="$1" file="$2" message="$3"
  if grep -Fq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

# ERE check, for the handful of assertions that are genuinely regexes over
# the file content rather than literal substrings (e.g. "a broad renewal
# exemption in any of several spellings").
require_grep() {
  local pattern="$1" file="$2" message="$3"
  grep -Eq -- "$pattern" "$file" || fail "$message"
}

reject_grep() {
  local pattern="$1" file="$2" message="$3"
  if grep -Eq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

# --- The canonical protected-set literals. Defined ONCE here so the fixture
# self-test and the real-file checks can never drift from each other. ------
REST_IDENTITY_REGEX='^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$'
CONFIRM_PATH='/api/v1/agents/renew-cert/confirm'
COMMAND_WS_REGEX='^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$'
EXEMPT_ENROLL='/api/v1/agents/enroll'
EXEMPT_RENEW='/api/v1/agents/renew-cert'
EXEMPT_CHALLENGE='/api/v1/agents/renew-cert/challenge'

# =============================================================================
# Reusable check functions (parameterized by file path) — these are the exact
# same functions run against fixtures below AND against the real repo files
# further down, so there is only one implementation of "what passes."
# =============================================================================

check_protected_route_literals() {
  local file="$1"
  require_fixed "$REST_IDENTITY_REGEX" "$file" \
    "$file must contain the exact REST identity protected-route regex: $REST_IDENTITY_REGEX"
  require_fixed "$CONFIRM_PATH" "$file" \
    "$file must contain the exact renewal-confirmation path: $CONFIRM_PATH"
  require_fixed "$COMMAND_WS_REGEX" "$file" \
    "$file must contain the exact command-WebSocket protected-route regex (missing command-WS coverage): $COMMAND_WS_REGEX"
}

check_exemption_literals_present() {
  local file="$1"
  require_fixed "$EXEMPT_ENROLL" "$file" "$file must document the exact enrollment exemption: $EXEMPT_ENROLL"
  require_fixed "$EXEMPT_RENEW" "$file" "$file must document the exact renewal-request exemption: $EXEMPT_RENEW"
  require_fixed "$EXEMPT_CHALLENGE" "$file" "$file must document the exact renewal-challenge exemption: $EXEMPT_CHALLENGE"
}

# Rejects the broad substring exemption forms the brief explicitly forbids.
# A `contains "/renew-cert"` (or equivalent wildcard) exempts BOTH the
# bearer-only renewal request AND /renew-cert/confirm — silently defeating
# confirmation's protection.
check_no_broad_renewal_exemption() {
  local file="$1"
  reject_grep 'uri\.path[[:space:]]+contains[[:space:]]+"/renew-cert"' "$file" \
    "$file must not use a broad 'contains \"/renew-cert\"' exemption — it also exempts /renew-cert/confirm"
  reject_grep '/renew-cert\*' "$file" \
    "$file must not use a '/renew-cert*' wildcard exemption"
  reject_grep 'contains[[:space:]]+"/enroll"' "$file" \
    "$file must not use a broad 'contains \"/enroll\"' exemption"
}

# Caddy-specific: the four-step edge normalization. Only meaningful for a
# Caddyfile-shaped fixture/file, since it asserts on header_up syntax.
check_caddy_edge_normalization() {
  local file="$1"

  # Step 1: discard inbound client-supplied Breeze assertion headers.
  require_fixed 'header_up -X-Breeze-Client-Cert-Verified' "$file" \
    "$file must discard inbound X-Breeze-Client-Cert-Verified (step 1)"
  require_fixed 'header_up -X-Breeze-Client-Cert-Serial' "$file" \
    "$file must discard inbound X-Breeze-Client-Cert-Serial (step 1)"

  # Step 2 / 4: raw provider certificate material (PEM/DER/fingerprint) must
  # never be forwarded to the API.
  require_fixed 'header_up -Cf-Client-Cert-Der-Base64' "$file" \
    "$file must discard raw provider certificate DER/PEM material before proxying to the API (step 2/4)"

  # Step 3: the two Breeze headers must be set from a verified-result
  # placeholder (produced by a `map` over the raw provider header), never a
  # bare rename/passthrough of client input.
  require_grep 'map[[:space:]]+\{http\.request\.header\.Cf-Client-Cert-Verified\}' "$file" \
    "$file must derive the verified assertion from an explicit map over the provider's verified-result header (step 3)"
  require_fixed 'header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}' "$file" \
    "$file must set X-Breeze-Client-Cert-Verified from the mapped placeholder, not a raw passthrough (step 3)"

  # Reject: forwarding a CLIENT-supplied Breeze assertion straight through
  # (setting the Breeze header from the client's own inbound Breeze header,
  # rather than from the verified provider result). This is the exact
  # "forwarding of a client-supplied Breeze assertion" the brief prohibits.
  reject_grep 'header_up[[:space:]]+X-Breeze-Client-Cert-(Verified|Serial)[[:space:]]+\{http\.request\.header\.X-Breeze-Client-Cert-(Verified|Serial)\}' "$file" \
    "$file must not forward a client-supplied X-Breeze-Client-Cert-* header — it must be discarded and re-derived from the verified provider result only"
}

# =============================================================================
# Self-test: prove the check functions above actually discriminate good from
# bad input, using disposable fixtures — run BEFORE trusting them against the
# real repo files.
# =============================================================================

SELF_TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$SELF_TEST_DIR"' EXIT

# NOTE: each check function calls fail(), which calls `exit`. Run it in a
# subshell here so a triggered failure only ends the subshell — letting these
# assert_* wrappers observe the exit status — instead of killing this whole
# script before the self-test can report which fixture broke.
assert_passes() {
  local fn="$1" file="$2" label="$3"
  if ! ( "$fn" "$file" ) >/dev/null 2>&1; then
    fail "self-test: expected '$label' fixture to PASS $fn, but it failed"
  fi
}

assert_fails() {
  local fn="$1" file="$2" label="$3"
  if ( "$fn" "$file" ) >/dev/null 2>&1; then
    fail "self-test: expected '$label' fixture to FAIL $fn, but it passed"
  fi
}

# --- Positive fixture: a minimal doc snippet that meets every requirement. --
GOOD_DOC="$SELF_TEST_DIR/good-doc.md"
cat > "$GOOD_DOC" <<EOF
Expression:
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?\$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws\$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
and not cf.tls_client_auth.cert_verified
EOF

assert_passes check_protected_route_literals "$GOOD_DOC" "good-doc"
assert_passes check_exemption_literals_present "$GOOD_DOC" "good-doc"
assert_passes check_no_broad_renewal_exemption "$GOOD_DOC" "good-doc"

# --- Negative fixture: the OLD broad-exemption doc shape. -------------------
BAD_DOC_BROAD="$SELF_TEST_DIR/bad-doc-broad.md"
cat > "$BAD_DOC_BROAD" <<'EOF'
Expression: (http.request.uri.path matches "^/api/v1/agents/[a-f0-9]+/" and not cf.tls_client_auth.cert_verified)
Exception: http.request.uri.path eq "/api/v1/agents/enroll"
           or http.request.uri.path contains "/renew-cert"
EOF

assert_fails check_no_broad_renewal_exemption "$BAD_DOC_BROAD" "bad-doc-broad"
assert_fails check_protected_route_literals "$BAD_DOC_BROAD" "bad-doc-broad (missing exact regexes / command-WS)"

# --- Negative fixture: missing command-WS coverage only. --------------------
BAD_DOC_NO_WS="$SELF_TEST_DIR/bad-doc-no-ws.md"
cat > "$BAD_DOC_NO_WS" <<EOF
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?\$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
EOF

assert_fails check_protected_route_literals "$BAD_DOC_NO_WS" "bad-doc-no-ws (missing command-WS coverage)"

# --- Positive Caddy fixture: correct 4-step normalization. ------------------
GOOD_CADDY="$SELF_TEST_DIR/good.Caddyfile"
cat > "$GOOD_CADDY" <<'EOF'
map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
  true true
  default false
}
reverse_proxy api:3001 {
  header_up -X-Breeze-Client-Cert-Verified
  header_up -X-Breeze-Client-Cert-Serial
  header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
  header_up X-Breeze-Client-Cert-Serial {http.request.header.Cf-Client-Cert-Serial}
  header_up -Cf-Client-Cert-Verified
  header_up -Cf-Client-Cert-Serial
  header_up -Cf-Client-Cert-Der-Base64
  header_up -Cf-Client-Cert-Sha256
}
EOF

assert_passes check_caddy_edge_normalization "$GOOD_CADDY" "good-Caddyfile"

# --- Negative Caddy fixture: otherwise complete, but sets the Breeze headers
# from the client's OWN inbound Breeze header instead of the verified/mapped
# provider result — isolates the passthrough check specifically (every other
# step is present and correct so this fixture fails ONLY on the passthrough).
BAD_CADDY_PASSTHROUGH="$SELF_TEST_DIR/bad-passthrough.Caddyfile"
cat > "$BAD_CADDY_PASSTHROUGH" <<'EOF'
map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
  true true
  default false
}
reverse_proxy api:3001 {
  header_up -X-Breeze-Client-Cert-Verified
  header_up -X-Breeze-Client-Cert-Serial
  header_up X-Breeze-Client-Cert-Verified {http.request.header.X-Breeze-Client-Cert-Verified}
  header_up X-Breeze-Client-Cert-Serial {http.request.header.X-Breeze-Client-Cert-Serial}
  header_up -Cf-Client-Cert-Der-Base64
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_PASSTHROUGH" "bad-passthrough (forwards client-supplied Breeze assertion)"

# --- Negative Caddy fixture: no discard step at all (relies only on the app
# layer, header survives untouched if a client sent it and nothing strips it).
BAD_CADDY_NO_STRIP="$SELF_TEST_DIR/bad-no-strip.Caddyfile"
cat > "$BAD_CADDY_NO_STRIP" <<'EOF'
map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
  true true
  default false
}
reverse_proxy api:3001 {
  header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
  header_up X-Breeze-Client-Cert-Serial {http.request.header.Cf-Client-Cert-Serial}
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_NO_STRIP" "bad-no-strip (missing inbound discard)"

# --- Negative Caddy fixture: forwards raw provider PEM/DER material. --------
BAD_CADDY_FORWARDS_DER="$SELF_TEST_DIR/bad-forwards-der.Caddyfile"
cat > "$BAD_CADDY_FORWARDS_DER" <<'EOF'
map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
  true true
  default false
}
reverse_proxy api:3001 {
  header_up -X-Breeze-Client-Cert-Verified
  header_up -X-Breeze-Client-Cert-Serial
  header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
  header_up X-Breeze-Client-Cert-Serial {http.request.header.Cf-Client-Cert-Serial}
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_FORWARDS_DER" "bad-forwards-der (never strips Cf-Client-Cert-Der-Base64)"

echo "check-agent-mtls-edge-policy: self-test fixtures OK (positive + negative cases both behave as expected)"

# =============================================================================
# Real-file checks — the actual gate.
# =============================================================================

for file in "$CADDYFILE" "$OPS_DOC" "$PUBLIC_DOC"; do
  [[ -f "$file" ]] || fail "expected file not found: $file"
  check_protected_route_literals "$file"
  check_exemption_literals_present "$file"
  check_no_broad_renewal_exemption "$file"
done

check_caddy_edge_normalization "$CADDYFILE"

# Self-host guidance must exist in both operator-facing docs: mode stays off
# unless the operator's own proxy validates the peer cert AND strips/
# overwrites both headers.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  require_fixed 'AGENT_MTLS_BINDING_MODE' "$file" \
    "$file must document AGENT_MTLS_BINDING_MODE for self-hosted operators"
  require_grep 'off.*unless.*(prox|proxy|reverse proxy)' "$file" \
    "$file must instruct self-hosted operators to leave mode off unless their proxy validates the peer certificate"
  require_grep '(strips?|strip)/?(overwrite|overwrites)' "$file" \
    "$file must require self-hosted proxies to strip/overwrite both assertion headers, not merely forward them"
  require_grep 'explicitly unsupported|not supported|unsupported' "$file" \
    "$file must state that setting the assertion headers from arbitrary client input is unsupported"
done

# Direct-origin bypass warning must exist in both operator-facing docs.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  require_grep 'direct.origin|directly.reachable|bypass' "$file" \
    "$file must warn that a directly-reachable origin bypasses the entire edge assertion contract"
done

echo "check-agent-mtls-edge-policy: OK ($CADDYFILE, $OPS_DOC, $PUBLIC_DOC all pin the exact protected route set and edge normalization contract)"
