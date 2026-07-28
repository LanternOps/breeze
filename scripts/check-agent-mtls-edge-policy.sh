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
# Exact exemptions (never a `contains` / wildcard / regex-suffix broad match):
#   /api/v1/agents/enroll, /api/v1/agents/renew-cert, /api/v1/agents/renew-cert/challenge
# The two operator-facing docs must express this as an exact Cloudflare Rules
# `not in {...}` set — not `contains`, `matches`, `starts_with`, or a wildcard
# glob against a renew-cert path, in EITHER token order.
#
# Caddy edge normalization (docker/Caddyfile.prod only, checked against the
# ACTIVE @agentMtlsProtected + handle @api region only — see
# extract_caddy_active_block — so a literal sitting in a comment, a dead
# block, or anywhere else in the file cannot satisfy these checks):
#   1. discard inbound X-Breeze-Client-Cert-Verified / -Serial
#   2. discard raw provider certificate headers from untrusted upstreams
#   3. set the two Breeze headers only from a verified result, and gate the
#      SERIAL on the identical verified condition (never a raw, unconditional
#      passthrough of the provider's serial header, and never a raw
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

# ERE checks, for the handful of assertions that are genuinely regexes over
# the file content rather than literal substrings (e.g. "a broad renewal
# exemption in any of several spellings"). The `_ci` variants are
# case-insensitive so a future rewording (e.g. "Contains" at a sentence
# start, "Off" mid-prose) can't silently regress a require/reject check that
# depends on exact case.
require_grep() {
  local pattern="$1" file="$2" message="$3"
  grep -Eq -- "$pattern" "$file" || fail "$message"
}

require_grep_ci() {
  local pattern="$1" file="$2" message="$3"
  grep -Eqi -- "$pattern" "$file" || fail "$message"
}

reject_grep() {
  local pattern="$1" file="$2" message="$3"
  if grep -Eq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

reject_grep_ci() {
  local pattern="$1" file="$2" message="$3"
  if grep -Eqi -- "$pattern" "$file"; then
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

# Keywords that, placed adjacent to a "renew-cert" path in an exemption
# expression, would broaden the exemption past the exact bearer-only set
# (e.g. `contains "/renew-cert"`, or the regex-suffix evasion
# `matches "^/api/v1/agents/renew-cert.*$"`, which is NOT caught by a bare
# `contains`/wildcard-glob check).
EXEMPTION_EVASION_KEYWORDS='contains|matches|starts_with|wildcard'

# =============================================================================
# Reusable check functions (parameterized by file path, plus an optional
# display label for error messages — used so checks run against an extracted
# temp file can still report the original source file's name) — these are the
# exact same functions run against fixtures below AND against the real repo
# files further down, so there is only one implementation of "what passes."
# =============================================================================

check_protected_route_literals() {
  local file="$1" label="${2:-$1}"
  require_fixed "$REST_IDENTITY_REGEX" "$file" \
    "$label must contain the exact REST identity protected-route regex: $REST_IDENTITY_REGEX"
  require_fixed "$CONFIRM_PATH" "$file" \
    "$label must contain the exact renewal-confirmation path: $CONFIRM_PATH"
  require_fixed "$COMMAND_WS_REGEX" "$file" \
    "$label must contain the exact command-WebSocket protected-route regex (missing command-WS coverage): $COMMAND_WS_REGEX"
}

check_exemption_literals_present() {
  local file="$1" label="${2:-$1}"
  require_fixed "$EXEMPT_ENROLL" "$file" "$label must document the exact enrollment exemption: $EXEMPT_ENROLL"
  require_fixed "$EXEMPT_RENEW" "$file" "$label must document the exact renewal-request exemption: $EXEMPT_RENEW"
  require_fixed "$EXEMPT_CHALLENGE" "$file" "$label must document the exact renewal-challenge exemption: $EXEMPT_CHALLENGE"
}

# Docs-only (Cloudflare Rules context): the exemption must be expressed as an
# exact set-membership test, `... not in {"a" "b" "c"}` — not merely present
# somewhere in the text as loose prose.
check_exact_exemption_not_in_form() {
  local file="$1" label="${2:-$1}"
  require_fixed 'not in {' "$file" \
    "$label must express the exemption as an exact Cloudflare Rules 'not in {...}' set-membership test"
  require_fixed "\"$EXEMPT_ENROLL\"" "$file" \
    "$label must quote the exact enrollment exemption inside the not-in set: \"$EXEMPT_ENROLL\""
  require_fixed "\"$EXEMPT_RENEW\"" "$file" \
    "$label must quote the exact renewal-request exemption inside the not-in set: \"$EXEMPT_RENEW\""
  require_fixed "\"$EXEMPT_CHALLENGE\"" "$file" \
    "$label must quote the exact renewal-challenge exemption inside the not-in set: \"$EXEMPT_CHALLENGE\""
}

# Rejects the broad substring/regex exemption forms the brief explicitly
# forbids. A `contains "/renew-cert"` (or equivalent wildcard, or a regex
# exemption like `matches "^/api/v1/agents/renew-cert.*$"`) exempts BOTH the
# bearer-only renewal request AND /renew-cert/confirm — silently defeating
# confirmation's protection. Checked in both token orders and case-
# insensitively so a rewording/reordering can't silently evade the guard.
check_no_broad_renewal_exemption() {
  local file="$1" label="${2:-$1}"
  local kw="$EXEMPTION_EVASION_KEYWORDS"

  reject_grep_ci "($kw)[^\"]{0,20}\"[^\"]*renew-cert" "$file" \
    "$label must not use a broad ($kw) match against a renew-cert path in an exemption position — this also evades via e.g. matches \"^/api/v1/agents/renew-cert.*\$\""
  reject_grep_ci "renew-cert[^\"]*\"[^\"]{0,20}($kw)" "$file" \
    "$label must not place a renew-cert path immediately adjacent to a broad ($kw) construct"
  reject_grep_ci 'renew-cert[^[:space:]"]{0,3}\*' "$file" \
    "$label must not use a wildcard-glob renewal exemption (e.g. /renew-cert*)"
  reject_grep_ci '\*[^[:space:]"]{0,3}renew-cert' "$file" \
    "$label must not use a wildcard-glob renewal exemption (e.g. */renew-cert)"
  reject_grep_ci 'contains[[:space:]]+"/enroll"' "$file" \
    "$label must not use a broad 'contains \"/enroll\"' exemption"
}

# Caddy-specific: the four-step edge normalization. Only meaningful for a
# Caddyfile-shaped fixture/file, since it asserts on header_up/map syntax.
check_caddy_edge_normalization() {
  local file="$1" label="${2:-$1}"

  # Step 1: discard inbound client-supplied Breeze assertion headers.
  require_fixed 'header_up -X-Breeze-Client-Cert-Verified' "$file" \
    "$label must discard inbound X-Breeze-Client-Cert-Verified (step 1)"
  require_fixed 'header_up -X-Breeze-Client-Cert-Serial' "$file" \
    "$label must discard inbound X-Breeze-Client-Cert-Serial (step 1)"

  # Step 2 / 4: raw provider certificate material (PEM/DER/fingerprint) must
  # never be forwarded to the API.
  require_fixed 'header_up -Cf-Client-Cert-Der-Base64' "$file" \
    "$label must discard raw provider certificate DER/PEM material before proxying to the API (step 2/4)"

  # Step 3: the VERIFIED flag must come from an explicit map over the
  # provider's raw verified-result header, never a bare rename/passthrough.
  require_grep 'map[[:space:]]+\{http\.request\.header\.Cf-Client-Cert-Verified\}[[:space:]]+\{breeze_agent_cert_verified\}' "$file" \
    "$label must derive the verified assertion from an explicit map over the provider's verified-result header (step 3)"
  require_fixed 'header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}' "$file" \
    "$label must set X-Breeze-Client-Cert-Verified from the mapped placeholder, not a raw passthrough (step 3)"

  # Step 3 (serial binding): the SERIAL must be gated on the SAME verified
  # source via its own map — not forwarded unconditionally. An unverified or
  # spoofed provider result must yield an empty serial too, not just a false
  # verified flag; otherwise a serial-only forgery could still slip through
  # wherever a caller reads the serial header without re-checking verified.
  require_grep 'map[[:space:]]+\{http\.request\.header\.Cf-Client-Cert-Verified\}[[:space:]]+\{breeze_agent_cert_serial\}' "$file" \
    "$label must gate the serial on the SAME Cf-Client-Cert-Verified source via its own map (step 3) — an unverified result must not carry a real serial"
  require_fixed 'header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}' "$file" \
    "$label must set X-Breeze-Client-Cert-Serial from the verified-gated placeholder, not directly from the raw provider header (step 3)"
  reject_grep 'header_up[[:space:]]+X-Breeze-Client-Cert-Serial[[:space:]]+\{http\.request\.header\.Cf-Client-Cert-Serial\}' "$file" \
    "$label must not forward Cf-Client-Cert-Serial unconditionally — it must be gated on the verified result via a map (step 3), not passed through directly"

  # Reject: forwarding a CLIENT-supplied Breeze assertion straight through
  # (setting the Breeze header from the client's own inbound Breeze header,
  # rather than from the verified provider result). This is the exact
  # "forwarding of a client-supplied Breeze assertion" the brief prohibits.
  reject_grep 'header_up[[:space:]]+X-Breeze-Client-Cert-(Verified|Serial)[[:space:]]+\{http\.request\.header\.X-Breeze-Client-Cert-(Verified|Serial)\}' "$file" \
    "$label must not forward a client-supplied X-Breeze-Client-Cert-* header — it must be discarded and re-derived from the verified provider result only"
}

# Extracts the ACTIVE Caddy region — from the @agentMtlsProtected matcher
# through the end of the `handle @api { ... }` block that actually proxies
# agent traffic — and drops full-line comments within it. A structural parse
# isn't needed (brace-depth counting is enough): capture starts at the
# @agentMtlsProtected marker, tracks nesting depth, and stops the SECOND time
# depth returns to zero (once for the matcher's own block, once for the
# subsequent handle @api block). This means a literal that exists only in a
# comment, or only in some OTHER inactive block elsewhere in the file, cannot
# satisfy any check run against this extracted output.
extract_caddy_active_block() {
  local file="$1"
  awk '
    BEGIN { capture = 0; depth = 0; blocks_closed = 0 }
    /@agentMtlsProtected[[:space:]]*\{/ { capture = 1 }
    capture {
      raw = $0
      if (raw ~ /^[[:space:]]*#/) { next }  # drop full-line comments
      print raw
      n_open = gsub(/\{/, "{", raw)
      n_close = gsub(/\}/, "}", raw)
      depth += n_open - n_close
      if (n_close > 0 && depth == 0) {
        blocks_closed++
        if (blocks_closed == 2) { capture = 0 }
      }
    }
  ' "$file"
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
assert_passes check_exact_exemption_not_in_form "$GOOD_DOC" "good-doc"
assert_passes check_no_broad_renewal_exemption "$GOOD_DOC" "good-doc"

# --- Negative fixture: the OLD broad-`contains`-exemption doc shape. --------
BAD_DOC_BROAD="$SELF_TEST_DIR/bad-doc-broad.md"
cat > "$BAD_DOC_BROAD" <<'EOF'
Expression: (http.request.uri.path matches "^/api/v1/agents/[a-f0-9]+/" and not cf.tls_client_auth.cert_verified)
Exception: http.request.uri.path eq "/api/v1/agents/enroll"
           or http.request.uri.path contains "/renew-cert"
EOF

assert_fails check_no_broad_renewal_exemption "$BAD_DOC_BROAD" "bad-doc-broad"
assert_fails check_protected_route_literals "$BAD_DOC_BROAD" "bad-doc-broad (missing exact regexes / command-WS)"

# --- Negative fixture: the REGEX-SUFFIX evasion — not `contains`, not a bare
# `*` glob, but a `matches` regex whose value still broadens the exemption
# past the exact bearer-only set. This is exactly the enumeration gap flagged
# in review: the OLD reject patterns (literal `contains "/renew-cert"` and
# `/renew-cert*`) did not catch this.
BAD_DOC_REGEX_EVASION="$SELF_TEST_DIR/bad-doc-regex-evasion.md"
cat > "$BAD_DOC_REGEX_EVASION" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$"
)
and not http.request.uri.path matches "^/api/v1/agents/renew-cert.*$"
and not cf.tls_client_auth.cert_verified
EOF

assert_fails check_no_broad_renewal_exemption "$BAD_DOC_REGEX_EVASION" "bad-doc-regex-evasion (matches \"...renew-cert.*\$\" exemption)"

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

# --- Negative fixture: exemption present as loose prose, not the exact
# `not in {...}` set-membership form.
BAD_DOC_LOOSE_EXEMPTION="$SELF_TEST_DIR/bad-doc-loose-exemption.md"
cat > "$BAD_DOC_LOOSE_EXEMPTION" <<EOF
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?\$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws\$"
)
and not cf.tls_client_auth.cert_verified

Exempt paths, informally: enrollment (/api/v1/agents/enroll), renewal
(/api/v1/agents/renew-cert), and the renewal challenge
(/api/v1/agents/renew-cert/challenge).
EOF

assert_fails check_exact_exemption_not_in_form "$BAD_DOC_LOOSE_EXEMPTION" "bad-doc-loose-exemption (no exact not-in set)"

# --- Positive Caddy fixture: correct 4-step normalization with the serial
# gated on the same verified source. ------------------------------------
GOOD_CADDY="$SELF_TEST_DIR/good.Caddyfile"
cat > "$GOOD_CADDY" <<'EOF'
@agentMtlsProtected {
  expression path_regexp('^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$') || path('/api/v1/agents/renew-cert/confirm') || path_regexp('^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$')
}

handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} {
    true {http.request.header.Cf-Client-Cert-Serial}
    default ""
  }
  reverse_proxy api:3001 {
    header_up -X-Breeze-Client-Cert-Verified
    header_up -X-Breeze-Client-Cert-Serial
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
    header_up -Cf-Client-Cert-Verified
    header_up -Cf-Client-Cert-Serial
    header_up -Cf-Client-Cert-Der-Base64
    header_up -Cf-Client-Cert-Sha256
  }
}
EOF

assert_passes check_protected_route_literals "$GOOD_CADDY" "good-Caddyfile"
assert_passes check_no_broad_renewal_exemption "$GOOD_CADDY" "good-Caddyfile"
assert_passes check_caddy_edge_normalization "$GOOD_CADDY" "good-Caddyfile"

# --- Negative Caddy fixture: otherwise complete, but sets the Breeze headers
# from the client's OWN inbound Breeze header instead of the verified/mapped
# provider result — isolates the passthrough check specifically (every other
# step is present and correct so this fixture fails ONLY on the passthrough).
BAD_CADDY_PASSTHROUGH="$SELF_TEST_DIR/bad-passthrough.Caddyfile"
cat > "$BAD_CADDY_PASSTHROUGH" <<'EOF'
handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} {
    true {http.request.header.Cf-Client-Cert-Serial}
    default ""
  }
  reverse_proxy api:3001 {
    header_up -X-Breeze-Client-Cert-Verified
    header_up -X-Breeze-Client-Cert-Serial
    header_up X-Breeze-Client-Cert-Verified {http.request.header.X-Breeze-Client-Cert-Verified}
    header_up X-Breeze-Client-Cert-Serial {http.request.header.X-Breeze-Client-Cert-Serial}
    header_up -Cf-Client-Cert-Der-Base64
  }
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_PASSTHROUGH" "bad-passthrough (forwards client-supplied Breeze assertion)"

# --- Negative Caddy fixture: no discard step at all (relies only on the app
# layer, header survives untouched if a client sent it and nothing strips it).
BAD_CADDY_NO_STRIP="$SELF_TEST_DIR/bad-no-strip.Caddyfile"
cat > "$BAD_CADDY_NO_STRIP" <<'EOF'
handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} {
    true {http.request.header.Cf-Client-Cert-Serial}
    default ""
  }
  reverse_proxy api:3001 {
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
  }
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_NO_STRIP" "bad-no-strip (missing inbound discard)"

# --- Negative Caddy fixture: forwards raw provider PEM/DER material. --------
BAD_CADDY_FORWARDS_DER="$SELF_TEST_DIR/bad-forwards-der.Caddyfile"
cat > "$BAD_CADDY_FORWARDS_DER" <<'EOF'
handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} {
    true {http.request.header.Cf-Client-Cert-Serial}
    default ""
  }
  reverse_proxy api:3001 {
    header_up -X-Breeze-Client-Cert-Verified
    header_up -X-Breeze-Client-Cert-Serial
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
  }
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_FORWARDS_DER" "bad-forwards-der (never strips Cf-Client-Cert-Der-Base64)"

# --- Negative Caddy fixture: the UNGATED-SERIAL regression this fix closes —
# verified is correctly mapped/gated, but the serial is still a direct,
# unconditional passthrough of the raw provider header regardless of the
# verified result.
BAD_CADDY_UNGATED_SERIAL="$SELF_TEST_DIR/bad-ungated-serial.Caddyfile"
cat > "$BAD_CADDY_UNGATED_SERIAL" <<'EOF'
handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  reverse_proxy api:3001 {
    header_up -X-Breeze-Client-Cert-Verified
    header_up -X-Breeze-Client-Cert-Serial
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {http.request.header.Cf-Client-Cert-Serial}
    header_up -Cf-Client-Cert-Der-Base64
  }
}
EOF

assert_fails check_caddy_edge_normalization "$BAD_CADDY_UNGATED_SERIAL" "bad-ungated-serial (serial not gated on verified)"

# --- Negative Caddy fixture: every required literal is present ONLY inside a
# comment within the active region (and the active region's REAL directives
# are all wrong/absent) — proves the extraction+comment-stripping is load-
# bearing, not merely the literal-presence checks themselves. Without
# stripping comments, a naive whole-file/whole-region grep would wrongly PASS
# this fixture.
BAD_CADDY_COMMENT_ONLY="$SELF_TEST_DIR/bad-comment-only.Caddyfile"
cat > "$BAD_CADDY_COMMENT_ONLY" <<'EOF'
@agentMtlsProtected {
  expression path('/never/matches/anything')
}

handle @api {
  # Aspirational notes, not real config:
  # ^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$
  # /api/v1/agents/renew-cert/confirm
  # ^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$
  # header_up -X-Breeze-Client-Cert-Verified
  # header_up -X-Breeze-Client-Cert-Serial
  # header_up -Cf-Client-Cert-Der-Base64
  # map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} { true true default false }
  # map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} { true {http.request.header.Cf-Client-Cert-Serial} default "" }
  # header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
  # header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
  reverse_proxy api:3001
}
EOF

# Sanity-check the vulnerability this closes: a naive whole-file grep (no
# extraction, no comment-stripping) against this fixture WOULD wrongly pass,
# because every literal is textually present. Confirms the fixture is a real
# regression test, not a fixture that happens to fail for an unrelated
# reason.
if ! ( check_protected_route_literals "$BAD_CADDY_COMMENT_ONLY" ) >/dev/null 2>&1; then
  fail "self-test: bad-comment-only fixture is invalid — a literal is missing even from the raw file, so it can't demonstrate the comment-stripping gap"
fi

# The real assertion: after extraction (which drops comment lines within the
# active region and, since the matcher's own `expression` never matches
# anything, contains none of these literals as live directives), every
# relevant check must FAIL.
EXTRACTED_COMMENT_ONLY="$SELF_TEST_DIR/bad-comment-only.extracted"
extract_caddy_active_block "$BAD_CADDY_COMMENT_ONLY" > "$EXTRACTED_COMMENT_ONLY"
assert_fails check_protected_route_literals "$EXTRACTED_COMMENT_ONLY" "bad-comment-only, extracted (literals live only in a comment)"
assert_fails check_caddy_edge_normalization "$EXTRACTED_COMMENT_ONLY" "bad-comment-only, extracted (normalization lives only in a comment)"

echo "check-agent-mtls-edge-policy: self-test fixtures OK (positive + negative cases both behave as expected)"

# =============================================================================
# Real-file checks — the actual gate.
# =============================================================================

for file in "$CADDYFILE" "$OPS_DOC" "$PUBLIC_DOC"; do
  [[ -f "$file" ]] || fail "expected file not found: $file"
done

# docs (Cloudflare Rules context): whole-file checks, including the exact
# `not in {...}` set-membership form.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  check_protected_route_literals "$file"
  check_exemption_literals_present "$file"
  check_exact_exemption_not_in_form "$file"
  check_no_broad_renewal_exemption "$file"
done

# Caddy: scoped to the ACTIVE @agentMtlsProtected + handle @api region only,
# with comments stripped, so a literal parked in a comment or dead block
# cannot satisfy any of these.
CADDY_ACTIVE_REGION="$SELF_TEST_DIR/caddy-active-region.extracted"
extract_caddy_active_block "$CADDYFILE" > "$CADDY_ACTIVE_REGION"
[[ -s "$CADDY_ACTIVE_REGION" ]] || \
  fail "$CADDYFILE: could not locate the @agentMtlsProtected ... handle @api active region for extraction"

CADDY_LABEL="$CADDYFILE (active @agentMtlsProtected/handle @api region, comments stripped)"
check_protected_route_literals "$CADDY_ACTIVE_REGION" "$CADDY_LABEL"
check_no_broad_renewal_exemption "$CADDY_ACTIVE_REGION" "$CADDY_LABEL"
check_caddy_edge_normalization "$CADDY_ACTIVE_REGION" "$CADDY_LABEL"

# Self-host guidance must exist in both operator-facing docs: mode stays off
# unless the operator's own proxy validates the peer cert AND strips/
# overwrites both headers. Case-insensitive: a rewording shouldn't be able to
# silently regress these checks via a case mismatch.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  require_fixed 'AGENT_MTLS_BINDING_MODE' "$file" \
    "$file must document AGENT_MTLS_BINDING_MODE for self-hosted operators"
  require_grep_ci 'off.*unless.*(prox|proxy|reverse proxy)' "$file" \
    "$file must instruct self-hosted operators to leave mode off unless their proxy validates the peer certificate"
  require_grep_ci '(strips?|strip)/?(overwrite|overwrites)' "$file" \
    "$file must require self-hosted proxies to strip/overwrite both assertion headers, not merely forward them"
  require_grep_ci 'explicitly unsupported|not supported|unsupported' "$file" \
    "$file must state that setting the assertion headers from arbitrary client input is unsupported"
done

# Direct-origin bypass warning must exist in both operator-facing docs.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  require_grep_ci 'direct.origin|directly.reachable|bypass' "$file" \
    "$file must warn that a directly-reachable origin bypasses the entire edge assertion contract"
done

echo "check-agent-mtls-edge-policy: OK ($CADDYFILE, $OPS_DOC, $PUBLIC_DOC all pin the exact protected route set and edge normalization contract)"
