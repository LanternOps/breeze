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
#   - REST identity:   ^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$
#   - confirmation:    /api/v1/agents/renew-cert/confirm   (exact)
#   - command WS:      ^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$
#   - extension agent: ^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$
#
# The identity segment is the AGENT ID — randomBytes(32).toString('hex'), i.e.
# 64 hex characters (routes/agents/helpers.ts `generateAgentId`), matched
# against devices.agent_id by middleware/agentAuth.ts and routes/agentWs.ts.
# The pre-final-review pattern `[0-9a-fA-F-]{36}` was a UUID shape and was
# exactly inverted: it matched NO agent route while it DID match the
# 36-character UUID admin routes (/api/v1/agents/<deviceId>/approve etc.,
# user-JWT + requirePermission). {64} cannot match a UUID, so the admin
# surface is excluded structurally, and a `36` pattern is now REJECTED
# outright by check_no_uuid_shaped_identity_regex below.
#
# Exact exemptions (never a `contains` / wildcard / regex-suffix broad match):
#   /api/v1/agents/enroll, /api/v1/agents/renew-cert, /api/v1/agents/renew-cert/challenge
# The two operator-facing docs must express this as an exact Cloudflare Rules
# `not in {...}` set — not `contains`, `matches`, `starts_with`, or a wildcard
# glob against a renew-cert path, in EITHER token order.
#
# Caddy edge normalization (docker/Caddyfile.prod only, checked against the
# ACTIVE @agentMtlsProtected + `handle @api` region only — see
# extract_caddy_active_block — so a literal sitting in a comment, a dead
# block, or anywhere else in the file cannot satisfy these checks):
#   1. discard inbound X-Breeze-Client-Cert-Verified / -Serial GLOBALLY, via a
#      site-level `request_header -...`, NOT via `header_up` inside the same
#      reverse_proxy that sets them (see below), and NOT per-route
#   2. discard raw provider certificate headers from untrusted upstreams, on
#      EVERY route that reaches the api origin
#   3. set the two Breeze headers only from a verified result, and gate the
#      SERIAL on the identical verified condition (never a raw, unconditional
#      passthrough of the provider's serial header, and never a raw
#      passthrough of a client-supplied Breeze header)
#   4. never forward client certificate PEM/DER/private material
#
# FINAL-REVIEW C1: this script previously MANDATED
# `header_up -X-Breeze-Client-Cert-Verified` inside the same reverse_proxy
# block as `header_up X-Breeze-Client-Cert-Verified {placeholder}`. Caddy
# compiles a reverse_proxy's header_up lines into ONE HeaderOps and applies
# `delete` AFTER `set` regardless of source order, so that mandated shape
# stripped the assertion it had just derived — verified against real caddy:2,
# the origin saw nothing at all. The requirement is now inverted: the discard
# must be a GLOBAL `request_header` (which also closes I6 — every other route
# that reaches api:3001) and a co-located `header_up -X-Breeze-*` is a hard
# REJECT.
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
REST_IDENTITY_REGEX='^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$'
CONFIRM_PATH='/api/v1/agents/renew-cert/confirm'
COMMAND_WS_REGEX='^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$'
EXT_AGENT_REGEX='^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$'
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
  require_fixed "$EXT_AGENT_REGEX" "$file" \
    "$label must contain the exact extension agent-mount protected-route regex (extensions/gateway.ts mounts a second agent-token surface): $EXT_AGENT_REGEX"
  check_no_uuid_shaped_identity_regex "$file" "$label"
}

# FINAL-REVIEW C3: a UUID-shaped identity segment ({36}, or an explicit
# 8-4-4-4-12 spelling) is not merely "a different way of writing the same
# thing" — it matches NO agent route (agent ids are 64 hex chars) and DOES
# match the 36-char UUID admin routes, i.e. it is exactly inverted. Reject it
# anywhere in an agent identity position so a future edit cannot silently
# reintroduce the inversion while still satisfying the literal checks above by
# keeping the correct regex somewhere else in the file.
check_no_uuid_shaped_identity_regex() {
  local file="$1" label="${2:-$1}"
  reject_grep '/api/v1/agents?(-ws)?/\[0-9a-fA-F-?\]\{36\}' "$file" \
    "$label must not use a UUID-shaped {36} agent identity segment — the agent id is randomBytes(32).toString('hex') = 64 hex chars, so {36} matches no agent route and wrongly matches the 36-char UUID admin routes (/api/v1/agents/<deviceId>/approve)"
  reject_grep '/api/v1/agents?(-ws)?/\[0-9a-fA-F\]\{8\}-' "$file" \
    "$label must not spell the agent identity segment as an 8-4-4-4-12 UUID — the agent id is a 64-hex string, not a UUID"
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

  # Step 1 (FINAL-REVIEW C1, INVERTED): the inbound-discard must NOT live in
  # the same reverse_proxy block as the set — Caddy applies HeaderOps deletes
  # after sets, so a co-located discard erases the assertion. Reject it here;
  # the global `request_header` form is required separately (see
  # check_caddy_global_assertion_strip, which runs against the WHOLE file
  # because the strip deliberately sits outside the handle @api region).
  reject_grep 'header_up[[:space:]]+-X-Breeze-Client-Cert-(Verified|Serial)' "$file" \
    "$label must NOT discard X-Breeze-Client-Cert-* with header_up inside the reverse_proxy that also sets them — Caddy applies HeaderOps deletes AFTER sets regardless of source order, so this silently strips the assertion it just derived (final-review C1, reproduced against caddy:2). Use the site-level 'request_header -X-Breeze-Client-Cert-*' instead."

  # Step 2 / 4: raw provider certificate material (PEM/DER/fingerprint) must
  # never be forwarded to the API. All four Cf-Client-Cert-* headers are
  # required, not just the DER one: dropping the -Verified/-Serial discards
  # would leak the raw, pre-map provider claim to the origin alongside the
  # normalized pair (I5 named bypass).
  require_fixed 'header_up -Cf-Client-Cert-Der-Base64' "$file" \
    "$label must discard raw provider certificate DER/PEM material before proxying to the API (step 2/4)"
  require_fixed 'header_up -Cf-Client-Cert-Sha256' "$file" \
    "$label must discard the raw provider certificate fingerprint header (step 2/4)"
  require_fixed 'header_up -Cf-Client-Cert-Verified' "$file" \
    "$label must discard the RAW provider verified header so only the normalized Breeze pair reaches the API (step 2/4)"
  require_fixed 'header_up -Cf-Client-Cert-Serial' "$file" \
    "$label must discard the RAW provider serial header so only the normalized Breeze pair reaches the API (step 2/4)"

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

# Drops full-line comments so a directive that exists only inside a comment can
# never satisfy a whole-file check.
strip_caddy_comments() {
  grep -v '^[[:space:]]*#' "$1" || true
}

# FINAL-REVIEW C1 + I6, step 1: the inbound X-Breeze-* discard must exist as a
# SITE-LEVEL `request_header` directive. Site-level (rather than per
# reverse_proxy) is what makes it apply to EVERY route that reaches the API
# origin — @streaming, @oauth and @oauthWellKnown all proxy to the same
# api:3001 through their own handle blocks and previously forwarded a forged
# X-Breeze-* header untouched (I6). It also structurally avoids C1's
# delete-after-set trap, since a `request_header` delete and a `header_up` set
# are separate header operations in separate phases.
check_caddy_global_assertion_strip() {
  local file="$1" label="${2:-$1}"
  require_grep '^[[:space:]]*request_header[[:space:]]+-X-Breeze-Client-Cert-Verified[[:space:]]*$' "$file" \
    "$label must strip inbound X-Breeze-Client-Cert-Verified GLOBALLY via a site-level 'request_header -X-Breeze-Client-Cert-Verified' (step 1) — a per-route strip leaves every other route to the API origin forgeable (I6)"
  require_grep '^[[:space:]]*request_header[[:space:]]+-X-Breeze-Client-Cert-Serial[[:space:]]*$' "$file" \
    "$label must strip inbound X-Breeze-Client-Cert-Serial GLOBALLY via a site-level 'request_header -X-Breeze-Client-Cert-Serial' (step 1)"
}

# FINAL-REVIEW I6: EVERY reverse_proxy that reaches the API origin must discard
# the raw provider certificate headers — not just the one in `handle @api`.
# A bare `reverse_proxy api:3001` (no block) cannot discard anything, so it is
# rejected outright. Runs over the whole comment-stripped file precisely
# because the point is to catch a route someone forgot.
check_caddy_api_origin_routes_stripped() {
  local file="$1" label="${2:-$1}"
  local findings
  findings="$(awk '
    /reverse_proxy[[:space:]]+api:3001/ {
      seen++
      if ($0 !~ /\{[[:space:]]*$/) { print "line " NR ": bare `reverse_proxy api:3001` with no header_up block"; next }
      depth = 1; block = ""
      while ((getline line) > 0) {
        block = block "\n" line
        tmp = line
        o = gsub(/\{/, "{", tmp); c = gsub(/\}/, "}", tmp)
        depth += o - c
        if (depth <= 0) break
      }
      miss = ""
      if (block !~ /header_up[ \t]+-Cf-Client-Cert-Verified/)    miss = miss " -Cf-Client-Cert-Verified"
      if (block !~ /header_up[ \t]+-Cf-Client-Cert-Serial/)      miss = miss " -Cf-Client-Cert-Serial"
      if (block !~ /header_up[ \t]+-Cf-Client-Cert-Der-Base64/)  miss = miss " -Cf-Client-Cert-Der-Base64"
      if (block !~ /header_up[ \t]+-Cf-Client-Cert-Sha256/)      miss = miss " -Cf-Client-Cert-Sha256"
      if (miss != "") print "line " NR ": missing discards:" miss
    }
    END { if (seen == 0) print "no `reverse_proxy api:3001` found at all" }
  ' "$file")"
  if [[ -n "$findings" ]]; then
    fail "$label: every reverse_proxy to the API origin must discard the raw provider certificate headers (I6). Offenders:"$'\n'"$findings"
  fi
}

# FINAL-REVIEW I5: the matcher must not be neutered while still textually
# containing the protected regexes — e.g. `(...) && false`, `&& 1 == 2`, or a
# matcher whose expression is commented out and replaced by a never-matching
# path.
check_caddy_matcher_not_neutered() {
  local file="$1" label="${2:-$1}"
  require_grep 'expression[[:space:]]+path_regexp' "$file" \
    "$label: the @agentMtlsProtected matcher must be a live CEL expression over path_regexp, not a placeholder"
  reject_grep '&&[[:space:]]*(false|0[[:space:]]*==[[:space:]]*1|1[[:space:]]*==[[:space:]]*2)' "$file" \
    "$label: the @agentMtlsProtected matcher must not be short-circuited to never match (e.g. '&& false')"
  reject_grep '(^|[^[:alnum:]_])false[[:space:]]*&&' "$file" \
    "$label: the @agentMtlsProtected matcher must not be short-circuited to never match (e.g. 'false && ...')"
}

# FINAL-REVIEW I5: the exemption set must contain EXACTLY the three bearer-only
# paths. A fourth entry (most obviously "/api/v1/agents/renew-cert/confirm")
# would silently remove confirmation from the protected set while every
# existing literal check still passed.
check_exemption_set_is_exactly_three() {
  local file="$1" label="${2:-$1}"
  local count
  count="$(awk '
    /not in[[:space:]]*\{/ { inset = 1 }
    inset {
      line = $0
      while (match(line, /"[^"]*"/)) {
        n++
        line = substr(line, RSTART + RLENGTH)
      }
      if ($0 ~ /\}/) { inset = 0 }
    }
    END { print n + 0 }
  ' "$file")"
  if [[ "$count" -ne 3 ]]; then
    fail "$label: the exemption 'not in {...}' set must contain EXACTLY the 3 bearer-only paths (enroll, renew-cert, renew-cert/challenge); found $count quoted entries. A 4th entry — especially renew-cert/confirm — silently removes a route from the protected set (I5)."
  fi
}

# FINAL-REVIEW I5: an exemption smuggled in as a negated inequality
# (`ne "/api/v1/agents/renew-cert/confirm"`, `!= "..."`) is semantically an
# exemption but evades every `not in {...}` / contains-style check.
check_no_inequality_exemption() {
  local file="$1" label="${2:-$1}"
  reject_grep_ci '(^|[^[:alnum:]_])(ne|!=)[[:space:]]*"[^"]*(renew-cert|/agents/|agent-ws)' "$file" \
    "$label must not express a path exemption as an inequality (ne / !=) — use the exact 'not in {...}' set only, so the exempt set stays enumerable and countable (I5)"
}

# Extracts a SPECIFIC named Caddy block by the pattern of its opening line,
# with full-line comments dropped, stopping when that block's own braces
# balance.
#
# FINAL-REVIEW I5: the previous implementation started at @agentMtlsProtected
# and blindly grabbed "the next two brace blocks by depth", never verifying the
# second one was actually `handle @api`. That was bypassable by inserting a
# decoy block carrying the normalization directives immediately after the
# matcher while the REAL `handle @api` was stripped — the checks would pass
# against the decoy and production would be unprotected. Binding extraction to
# the block's NAME removes the whole class: the matcher assertions run against
# the `@agentMtlsProtected` block and only it, and the normalization assertions
# run against the `handle @api` block and only it.
#
# A commented-out opening line can never start a capture (the trigger requires
# the line not be a comment), so a `# handle @api {` decoy cannot shift the
# extraction window either.
extract_caddy_named_block() {
  local file="$1" open_pattern="$2"
  awk -v pat="$open_pattern" '
    BEGIN { capture = 0; depth = 0; done = 0 }
    done { next }
    !capture && $0 !~ /^[[:space:]]*#/ && $0 ~ pat && $0 ~ /\{[[:space:]]*$/ {
      capture = 1
      depth = 0
    }
    capture {
      raw = $0
      if (raw ~ /^[[:space:]]*#/) { next }  # drop full-line comments
      print raw
      n_open = gsub(/\{/, "{", raw)
      n_close = gsub(/\}/, "}", raw)
      depth += n_open - n_close
      if (n_close > 0 && depth == 0) { capture = 0; done = 1 }
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
cat > "$GOOD_DOC" <<'EOF'
Expression:
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
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
assert_passes check_exemption_set_is_exactly_three "$GOOD_DOC" "good-doc"
assert_passes check_no_inequality_exemption "$GOOD_DOC" "good-doc"

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
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
)
and not http.request.uri.path matches "^/api/v1/agents/renew-cert.*$"
and not cf.tls_client_auth.cert_verified
EOF

assert_fails check_no_broad_renewal_exemption "$BAD_DOC_REGEX_EVASION" "bad-doc-regex-evasion (matches \"...renew-cert.*\$\" exemption)"

# --- Negative fixture: missing command-WS coverage only. --------------------
BAD_DOC_NO_WS="$SELF_TEST_DIR/bad-doc-no-ws.md"
cat > "$BAD_DOC_NO_WS" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
EOF

assert_fails check_protected_route_literals "$BAD_DOC_NO_WS" "bad-doc-no-ws (missing command-WS coverage)"

# --- Negative fixture (FINAL-REVIEW C3): the UUID-shaped identity segment.
# This is the exact inverted regex the wave shipped: it matches no agent route
# (agent ids are 64 hex chars) and DOES match the 36-char UUID admin routes.
BAD_DOC_UUID_IDENTITY="$SELF_TEST_DIR/bad-doc-uuid-identity.md"
cat > "$BAD_DOC_UUID_IDENTITY" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F-]{36}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F-]{36}/ws$"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
EOF

assert_fails check_protected_route_literals "$BAD_DOC_UUID_IDENTITY" "bad-doc-uuid-identity (36-char UUID identity segment)"
assert_fails check_no_uuid_shaped_identity_regex "$BAD_DOC_UUID_IDENTITY" "bad-doc-uuid-identity (isolated UUID-shape check)"

# --- Negative fixture (FINAL-REVIEW C3): correct 64-hex core regexes but the
# extension agent mount is missing from the protected set.
BAD_DOC_NO_EXT="$SELF_TEST_DIR/bad-doc-no-ext.md"
cat > "$BAD_DOC_NO_EXT" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
EOF

assert_fails check_protected_route_literals "$BAD_DOC_NO_EXT" "bad-doc-no-ext (extension agent mount unprotected)"

# --- Negative fixture: exemption present as loose prose, not the exact
# `not in {...}` set-membership form.
BAD_DOC_LOOSE_EXEMPTION="$SELF_TEST_DIR/bad-doc-loose-exemption.md"
cat > "$BAD_DOC_LOOSE_EXEMPTION" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
)
and not cf.tls_client_auth.cert_verified

Exempt paths, informally: enrollment (/api/v1/agents/enroll), renewal
(/api/v1/agents/renew-cert), and the renewal challenge
(/api/v1/agents/renew-cert/challenge).
EOF

assert_fails check_exact_exemption_not_in_form "$BAD_DOC_LOOSE_EXEMPTION" "bad-doc-loose-exemption (no exact not-in set)"

# --- Negative fixture (FINAL-REVIEW I5): a FOURTH exemption entry smuggles the
# confirmation route out of the protected set while every literal-presence
# check still passes.
BAD_DOC_FOURTH_EXEMPTION="$SELF_TEST_DIR/bad-doc-fourth-exemption.md"
cat > "$BAD_DOC_FOURTH_EXEMPTION" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
  "/api/v1/agents/renew-cert/confirm"
}
EOF

assert_passes check_protected_route_literals "$BAD_DOC_FOURTH_EXEMPTION" "bad-doc-fourth-exemption (literals all present — proves the count check is load-bearing)"
assert_fails check_exemption_set_is_exactly_three "$BAD_DOC_FOURTH_EXEMPTION" "bad-doc-fourth-exemption (4 entries in the not-in set)"

# --- Negative fixture (FINAL-REVIEW I5): an exemption expressed as an
# inequality rather than set membership — semantically identical, invisible to
# every not-in / contains check.
BAD_DOC_NE_EXEMPTION="$SELF_TEST_DIR/bad-doc-ne-exemption.md"
cat > "$BAD_DOC_NE_EXEMPTION" <<'EOF'
(
  http.request.uri.path matches "^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$"
  or http.request.uri.path eq "/api/v1/agents/renew-cert/confirm"
  or http.request.uri.path matches "^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$"
  or http.request.uri.path matches "^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$"
)
and http.request.uri.path not in {
  "/api/v1/agents/enroll"
  "/api/v1/agents/renew-cert"
  "/api/v1/agents/renew-cert/challenge"
}
and http.request.uri.path ne "/api/v1/agents/renew-cert/confirm"
EOF

assert_fails check_no_inequality_exemption "$BAD_DOC_NE_EXEMPTION" "bad-doc-ne-exemption (ne-based smuggled exemption)"

# =============================================================================
# Caddy fixtures. NOTE the structure every fixture below mirrors, because the
# extraction is now bound to block NAMES (see extract_caddy_named_block):
#   - the site-level `request_header -X-Breeze-*` GLOBAL strip
#   - the `@agentMtlsProtected { ... }` matcher block  (route-set assertions)
#   - the `handle @api { ... }` block                  (normalization assertions)
# =============================================================================

CADDY_MATCHER_OPEN='@agentMtlsProtected'
CADDY_API_OPEN='handle @api'

# Convenience: run a check against a NAMED block extracted from a fixture.
assert_block_passes() {
  local fn="$1" file="$2" open="$3" label="$4"
  local extracted="$SELF_TEST_DIR/block.$$"
  extract_caddy_named_block "$file" "$open" > "$extracted"
  assert_passes "$fn" "$extracted" "$label"
}

assert_block_fails() {
  local fn="$1" file="$2" open="$3" label="$4"
  local extracted="$SELF_TEST_DIR/block.$$"
  extract_caddy_named_block "$file" "$open" > "$extracted"
  assert_fails "$fn" "$extracted" "$label"
}

# --- Positive Caddy fixture: global strip + live matcher + correct
# normalization with the serial gated on the same verified source, and NO
# co-located X-Breeze discard. -------------------------------------------
GOOD_CADDY="$SELF_TEST_DIR/good.Caddyfile"
cat > "$GOOD_CADDY" <<'EOF'
example.com {
  request_header -X-Breeze-Client-Cert-Verified
  request_header -X-Breeze-Client-Cert-Serial

  @agentMtlsProtected {
    expression path_regexp('^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$') || path('/api/v1/agents/renew-cert/confirm') || path_regexp('^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$') || path_regexp('^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$')
  }

  @streaming path /api/v1/mcp/sse
  handle @streaming {
    reverse_proxy api:3001 {
      flush_interval -1
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
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
      header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
      header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
  }
}
EOF

GOOD_CADDY_STRIPPED="$SELF_TEST_DIR/good.Caddyfile.nocomments"
strip_caddy_comments "$GOOD_CADDY" > "$GOOD_CADDY_STRIPPED"
assert_passes check_caddy_global_assertion_strip "$GOOD_CADDY_STRIPPED" "good-Caddyfile"
assert_passes check_caddy_api_origin_routes_stripped "$GOOD_CADDY_STRIPPED" "good-Caddyfile"
assert_block_passes check_protected_route_literals "$GOOD_CADDY" "$CADDY_MATCHER_OPEN" "good-Caddyfile matcher"
assert_block_passes check_caddy_matcher_not_neutered "$GOOD_CADDY" "$CADDY_MATCHER_OPEN" "good-Caddyfile matcher"
assert_block_passes check_no_broad_renewal_exemption "$GOOD_CADDY" "$CADDY_MATCHER_OPEN" "good-Caddyfile matcher"
assert_block_passes check_caddy_edge_normalization "$GOOD_CADDY" "$CADDY_API_OPEN" "good-Caddyfile handle @api"

# --- Negative Caddy fixture (FINAL-REVIEW C1): the shipped-and-broken shape —
# the inbound X-Breeze discard co-located with the set in ONE reverse_proxy.
# Caddy applies HeaderOps deletes after sets, so this strips the assertion it
# just derived and the origin sees nothing. This fixture is the regression
# test for the exact defect the wave shipped.
BAD_CADDY_COLOCATED_DISCARD="$SELF_TEST_DIR/bad-colocated-discard.Caddyfile"
cat > "$BAD_CADDY_COLOCATED_DISCARD" <<'EOF'
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

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_COLOCATED_DISCARD" "$CADDY_API_OPEN" \
  "bad-colocated-discard (C1: header_up -X-Breeze-* in the same block as the set)"

# --- Negative Caddy fixture (FINAL-REVIEW C1/I6): no GLOBAL strip at all, so a
# client-supplied X-Breeze-* survives on every route that isn't handle @api.
BAD_CADDY_NO_GLOBAL_STRIP="$SELF_TEST_DIR/bad-no-global-strip.Caddyfile"
cat > "$BAD_CADDY_NO_GLOBAL_STRIP" <<'EOF'
example.com {
  handle @api {
    reverse_proxy api:3001 {
      header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
      header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
  }
}
EOF

assert_fails check_caddy_global_assertion_strip "$BAD_CADDY_NO_GLOBAL_STRIP" "bad-no-global-strip (no site-level request_header strip)"

# --- Negative Caddy fixture (FINAL-REVIEW I6): a SECOND route reaching the API
# origin that never discards the raw provider headers. handle @api itself is
# perfect, so this fixture isolates the per-route coverage check.
BAD_CADDY_UNSTRIPPED_ROUTE="$SELF_TEST_DIR/bad-unstripped-route.Caddyfile"
cat > "$BAD_CADDY_UNSTRIPPED_ROUTE" <<'EOF'
example.com {
  request_header -X-Breeze-Client-Cert-Verified
  request_header -X-Breeze-Client-Cert-Serial

  handle @streaming {
    reverse_proxy api:3001 {
      flush_interval -1
    }
  }

  handle @api {
    reverse_proxy api:3001 {
      header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
      header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
  }
}
EOF

assert_fails check_caddy_api_origin_routes_stripped "$BAD_CADDY_UNSTRIPPED_ROUTE" "bad-unstripped-route (I6: @streaming reaches api:3001 without discards)"

# --- Negative Caddy fixture (FINAL-REVIEW I6): a BARE `reverse_proxy api:3001`
# with no block at all can't discard anything.
BAD_CADDY_BARE_PROXY="$SELF_TEST_DIR/bad-bare-proxy.Caddyfile"
cat > "$BAD_CADDY_BARE_PROXY" <<'EOF'
example.com {
  request_header -X-Breeze-Client-Cert-Verified
  request_header -X-Breeze-Client-Cert-Serial

  handle @oauth {
    reverse_proxy api:3001
  }
}
EOF

assert_fails check_caddy_api_origin_routes_stripped "$BAD_CADDY_BARE_PROXY" "bad-bare-proxy (bare reverse_proxy to the API origin)"

# --- Negative Caddy fixture: sets the Breeze headers from the client's OWN
# inbound Breeze header instead of the verified/mapped provider result.
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
    header_up X-Breeze-Client-Cert-Verified {http.request.header.X-Breeze-Client-Cert-Verified}
    header_up X-Breeze-Client-Cert-Serial {http.request.header.X-Breeze-Client-Cert-Serial}
    header_up -Cf-Client-Cert-Verified
    header_up -Cf-Client-Cert-Serial
    header_up -Cf-Client-Cert-Der-Base64
    header_up -Cf-Client-Cert-Sha256
  }
}
EOF

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_PASSTHROUGH" "$CADDY_API_OPEN" \
  "bad-passthrough (forwards client-supplied Breeze assertion)"

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
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
  }
}
EOF

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_FORWARDS_DER" "$CADDY_API_OPEN" \
  "bad-forwards-der (never strips Cf-Client-Cert-Der-Base64)"

# --- Negative Caddy fixture (FINAL-REVIEW I5): the raw provider
# verified/serial discards deleted while the DER/Sha256 ones remain — the
# named bypass "only -Der-Base64 is required".
BAD_CADDY_RAW_VERIFIED_LEAK="$SELF_TEST_DIR/bad-raw-verified-leak.Caddyfile"
cat > "$BAD_CADDY_RAW_VERIFIED_LEAK" <<'EOF'
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
    header_up -Cf-Client-Cert-Der-Base64
    header_up -Cf-Client-Cert-Sha256
  }
}
EOF

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_RAW_VERIFIED_LEAK" "$CADDY_API_OPEN" \
  "bad-raw-verified-leak (I5: raw Cf-Client-Cert-Verified/-Serial discards removed)"

# --- Negative Caddy fixture: the UNGATED-SERIAL regression. -----------------
BAD_CADDY_UNGATED_SERIAL="$SELF_TEST_DIR/bad-ungated-serial.Caddyfile"
cat > "$BAD_CADDY_UNGATED_SERIAL" <<'EOF'
handle @api {
  map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} {
    true true
    default false
  }
  reverse_proxy api:3001 {
    header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
    header_up X-Breeze-Client-Cert-Serial {http.request.header.Cf-Client-Cert-Serial}
    header_up -Cf-Client-Cert-Verified
    header_up -Cf-Client-Cert-Serial
    header_up -Cf-Client-Cert-Der-Base64
    header_up -Cf-Client-Cert-Sha256
  }
}
EOF

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_UNGATED_SERIAL" "$CADDY_API_OPEN" \
  "bad-ungated-serial (serial not gated on verified)"

# --- Negative Caddy fixture (FINAL-REVIEW I5): the DECOY-BLOCK bypass. The
# real `handle @api` is stripped bare, while a decoy block placed immediately
# after the matcher carries a complete, correct-looking normalization. The OLD
# extractor grabbed "the next two brace blocks by depth" and would have
# validated the decoy; name-bound extraction validates `handle @api` itself.
BAD_CADDY_DECOY_BLOCK="$SELF_TEST_DIR/bad-decoy-block.Caddyfile"
cat > "$BAD_CADDY_DECOY_BLOCK" <<'EOF'
example.com {
  request_header -X-Breeze-Client-Cert-Verified
  request_header -X-Breeze-Client-Cert-Serial

  @agentMtlsProtected {
    expression path_regexp('^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$') || path('/api/v1/agents/renew-cert/confirm') || path_regexp('^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$') || path_regexp('^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$')
  }

  handle @decoyNeverMatches {
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
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
  }

  handle @api {
    reverse_proxy api:3001 {
      header_up -Cf-Client-Cert-Verified
      header_up -Cf-Client-Cert-Serial
      header_up -Cf-Client-Cert-Der-Base64
      header_up -Cf-Client-Cert-Sha256
    }
  }
}
EOF

assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_DECOY_BLOCK" "$CADDY_API_OPEN" \
  "bad-decoy-block (I5: normalization lives in a decoy block, real handle @api is bare)"

# --- Negative Caddy fixture (FINAL-REVIEW I5): the matcher is short-circuited
# to never match while textually containing every protected regex.
BAD_CADDY_NEUTERED_MATCHER="$SELF_TEST_DIR/bad-neutered-matcher.Caddyfile"
cat > "$BAD_CADDY_NEUTERED_MATCHER" <<'EOF'
@agentMtlsProtected {
  expression (path_regexp('^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$') || path('/api/v1/agents/renew-cert/confirm') || path_regexp('^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$') || path_regexp('^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$')) && false
}
EOF

assert_block_passes check_protected_route_literals "$BAD_CADDY_NEUTERED_MATCHER" "$CADDY_MATCHER_OPEN" \
  "bad-neutered-matcher (literals all present — proves the neutering check is load-bearing)"
assert_block_fails check_caddy_matcher_not_neutered "$BAD_CADDY_NEUTERED_MATCHER" "$CADDY_MATCHER_OPEN" \
  "bad-neutered-matcher (I5: '&& false' short-circuit)"

# --- Negative Caddy fixture: every required literal is present ONLY inside a
# comment (and the real directives are absent) — proves comment-stripping is
# load-bearing, not merely the literal-presence checks themselves.
BAD_CADDY_COMMENT_ONLY="$SELF_TEST_DIR/bad-comment-only.Caddyfile"
cat > "$BAD_CADDY_COMMENT_ONLY" <<'EOF'
@agentMtlsProtected {
  expression path('/never/matches/anything')
}

handle @api {
  # Aspirational notes, not real config:
  # ^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$
  # /api/v1/agents/renew-cert/confirm
  # ^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$
  # ^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$
  # header_up -Cf-Client-Cert-Verified
  # header_up -Cf-Client-Cert-Serial
  # header_up -Cf-Client-Cert-Der-Base64
  # header_up -Cf-Client-Cert-Sha256
  # map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_verified} { true true default false }
  # map {http.request.header.Cf-Client-Cert-Verified} {breeze_agent_cert_serial} { true {http.request.header.Cf-Client-Cert-Serial} default "" }
  # header_up X-Breeze-Client-Cert-Verified {breeze_agent_cert_verified}
  # header_up X-Breeze-Client-Cert-Serial {breeze_agent_cert_serial}
  reverse_proxy api:3001
}
EOF

# Sanity-check the vulnerability this closes: a naive whole-file grep (no
# extraction, no comment-stripping) against this fixture WOULD wrongly pass,
# because every literal is textually present.
if ! ( check_protected_route_literals "$BAD_CADDY_COMMENT_ONLY" ) >/dev/null 2>&1; then
  fail "self-test: bad-comment-only fixture is invalid — a literal is missing even from the raw file, so it can't demonstrate the comment-stripping gap"
fi

assert_block_fails check_protected_route_literals "$BAD_CADDY_COMMENT_ONLY" "$CADDY_MATCHER_OPEN" \
  "bad-comment-only (literals live only in a comment)"
assert_block_fails check_caddy_edge_normalization "$BAD_CADDY_COMMENT_ONLY" "$CADDY_API_OPEN" \
  "bad-comment-only (normalization lives only in a comment)"

echo "check-agent-mtls-edge-policy: self-test fixtures OK (positive + negative cases both behave as expected)"

# =============================================================================
# Real-file checks — the actual gate.
# =============================================================================

for file in "$CADDYFILE" "$OPS_DOC" "$PUBLIC_DOC"; do
  [[ -f "$file" ]] || fail "expected file not found: $file"
done

# docs (Cloudflare Rules context): whole-file checks, including the exact
# `not in {...}` set-membership form and its exact cardinality.
for file in "$OPS_DOC" "$PUBLIC_DOC"; do
  check_protected_route_literals "$file"
  check_exemption_literals_present "$file"
  check_exact_exemption_not_in_form "$file"
  check_no_broad_renewal_exemption "$file"
  check_exemption_set_is_exactly_three "$file"
  check_no_inequality_exemption "$file"
done

# Caddy: route-set assertions run against the ACTIVE @agentMtlsProtected
# matcher block, normalization assertions against the ACTIVE `handle @api`
# block — each extracted BY NAME with comments stripped, so neither a literal
# parked in a comment nor a decoy block can satisfy them (I5).
CADDY_MATCHER_REGION="$SELF_TEST_DIR/caddy-matcher.extracted"
CADDY_API_REGION="$SELF_TEST_DIR/caddy-api.extracted"
CADDY_NO_COMMENTS="$SELF_TEST_DIR/caddy-nocomments"

extract_caddy_named_block "$CADDYFILE" "$CADDY_MATCHER_OPEN" > "$CADDY_MATCHER_REGION"
extract_caddy_named_block "$CADDYFILE" "$CADDY_API_OPEN" > "$CADDY_API_REGION"
strip_caddy_comments "$CADDYFILE" > "$CADDY_NO_COMMENTS"

[[ -s "$CADDY_MATCHER_REGION" ]] || \
  fail "$CADDYFILE: could not locate the active @agentMtlsProtected matcher block for extraction"
[[ -s "$CADDY_API_REGION" ]] || \
  fail "$CADDYFILE: could not locate the active 'handle @api' block for extraction"

CADDY_MATCHER_LABEL="$CADDYFILE (active @agentMtlsProtected matcher block, comments stripped)"
CADDY_API_LABEL="$CADDYFILE (active handle @api block, comments stripped)"

check_protected_route_literals "$CADDY_MATCHER_REGION" "$CADDY_MATCHER_LABEL"
check_caddy_matcher_not_neutered "$CADDY_MATCHER_REGION" "$CADDY_MATCHER_LABEL"
check_no_broad_renewal_exemption "$CADDY_MATCHER_REGION" "$CADDY_MATCHER_LABEL"
check_caddy_edge_normalization "$CADDY_API_REGION" "$CADDY_API_LABEL"

# Whole-file (comments stripped): the GLOBAL inbound strip, and the I6
# requirement that EVERY route reaching the API origin discards the raw
# provider headers — both are deliberately about coverage OUTSIDE handle @api.
check_caddy_global_assertion_strip "$CADDY_NO_COMMENTS" "$CADDYFILE (comments stripped)"
check_caddy_api_origin_routes_stripped "$CADDY_NO_COMMENTS" "$CADDYFILE (comments stripped)"

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
