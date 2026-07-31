#!/usr/bin/env bash
#
# check-agent-binary-signatures.sh — regression guard for issue #2797.
#
# agent/internal/security/threats.go used to embed plaintext threat-signature
# strings (the standard AV test-file payload and credential-theft tool names)
# as Go string literals. Those bytes landed verbatim in every shipped agent
# binary, and AV engines flagged breeze-agent.exe / breeze-user-helper.exe as
# malware (VirusTotal: Elastic Multi.* detections). The strings are now
# obfuscated in source (XOR, decoded at runtime); this guard fails CI/release
# if a plaintext signature ever reappears:
#
#   check-agent-binary-signatures.sh --source          scan agent/ Go source
#   check-agent-binary-signatures.sh <bin> [<bin>...]  scan built binaries
#
# IMPORTANT: every banned needle below is assembled at runtime from
# concatenated fragments. If any token appeared contiguously in this file,
# the script would flag itself, and — worse — AV engines could flag any
# artifact bundling this script, recreating the exact problem the guard
# exists to prevent. Never "simplify" the fragments into a single literal.
#
# Binary scanning deliberately uses plain `grep -a` over the raw file rather
# than the `strings` utility: GNU vs BSD `strings` behave differently and the
# tool is absent from git-bash on Windows runners, while `grep -a` works
# everywhere (ubuntu, macos, windows runners).

set -euo pipefail

# Remember where the caller invoked us from so relative binary paths resolve
# against the caller's cwd (standard CLI semantics), then run from the repo
# root so --source mode's `agent/` path always resolves.
caller_dir=$PWD
cd "$(dirname "$0")/../.."

fail() {
  echo "agent-binary-signatures: $*" >&2
  exit 1
}

# --- banned needles, built from fragments (see header comment) ---------------

# The AV test-file NAME token. The short form below is a substring of this, so
# matches are reported longest-needle-first and subsumed shorter needles are
# skipped to keep the output readable.
tok_av_name="EIC""AR-STANDARD-""ANTIVIRUS-TEST-FILE"

# Short form of the same token (case-insensitive catch-all).
tok_av_short="eic""ar"

# The full 68-byte AV test payload: prefix + name token + suffix. The prefix
# is itself split in two because AV engines also key on it. Note the single
# literal backslash after the `4` — Go source spelled it with an escaped
# backslash (`4\\P`) but the actual bytes contain exactly one.
tok_av_payload='X5O!P%@AP[4\'"PZX54(P^)7CC)7}"'$'"${tok_av_name}"'!$H+H*'

# Credential-theft / malware tool name tokens (case-insensitive substrings).
tool_tokens=(
  "mimi""katz"
  "seku""rlsa"
  "lsad""ump"
  "cobalt""strike"
  "trick""bot"
)

# This tool token is special: matched case-insensitively it is a substring of
# perfectly ordinary Go identifiers and string literals — any camelCase name
# of the form remote-T... (spelled with a hyphen here so this script does not
# contain the collision bytes itself; think of the slog keys and track
# handlers in agent/internal/remote/desktop). Those names appear all over the
# agent and its dependencies and survive into binaries (string literals, plus
# pclntab function names which `-s -w` does not strip). Require a
# non-alphanumeric byte (or start of line) before the token: real regressions
# still match (a Go string literal is preceded by a quote), while camelCase
# identifiers do not.
tok_emo="emo""tet"
tok_emo_re="(^|[^[:alnum:]_])${tok_emo}"

violations=0

report() {
  echo "  $*" >&2
  violations=$((violations + 1))
}

# --- source mode -------------------------------------------------------------

# grep_source <needle> <label> [<matcher>] — report every agent/ Go source
# line containing <needle> (case-insensitive; fixed-string by default, pass
# matcher `E` for an extended-regex needle). Returns 0 if anything matched.
grep_source() {
  local needle=$1 label=$2 matcher=${3:-F} hits line
  if hits=$(LC_ALL=C grep -r -n -i "-$matcher" --include='*.go' -- "$needle" agent/ 2>/dev/null); then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      # line = path:lineno:content — keep only path:lineno for the report.
      report "$(printf '%s' "$line" | cut -d: -f1,2): contains $label"
    done <<<"$hits"
    return 0
  fi
  return 1
}

scan_source() {
  # Longest-first with subsumption: the payload contains the name token, and
  # the name token contains the short token — avoid triple-reporting a line.
  if ! grep_source "$tok_av_payload" "the full AV test-file payload"; then
    if ! grep_source "$tok_av_name" "the AV test-file name token"; then
      grep_source "$tok_av_short" "the short AV test token" || true
    fi
  fi
  local tok
  for tok in "${tool_tokens[@]}"; do
    grep_source "$tok" "banned tool token '$tok'" || true
  done
  grep_source "$tok_emo_re" "banned tool token '$tok_emo'" E || true
}

# --- binary mode -------------------------------------------------------------

bin_has() {
  # Raw-byte, case-insensitive match (fixed-string by default, `E` for regex).
  # -a treats the binary as text; LC_ALL=C keeps matching byte-wise (no
  # locale/UTF-8 surprises).
  local matcher=${3:-F}
  LC_ALL=C grep -a -i "-$matcher" -q -- "$2" "$1"
}

scan_binary() {
  local bin=$1 tok
  case "$bin" in
    /*) ;;
    *) bin="$caller_dir/$bin" ;;
  esac
  # A guard that silently scans nothing is worse than no guard: refuse to
  # "pass" a missing or empty file.
  [ -e "$bin" ] || fail "binary not found: $bin"
  [ -f "$bin" ] || fail "not a regular file: $bin"
  [ -s "$bin" ] || fail "binary is empty: $bin"

  if bin_has "$bin" "$tok_av_payload"; then
    report "$bin: contains the full AV test-file payload"
  elif bin_has "$bin" "$tok_av_name"; then
    report "$bin: contains the AV test-file name token"
  elif bin_has "$bin" "$tok_av_short"; then
    report "$bin: contains the short AV test token"
  fi
  for tok in "${tool_tokens[@]}"; do
    if bin_has "$bin" "$tok"; then
      report "$bin: contains banned tool token '$tok'"
    fi
  done
  if bin_has "$bin" "$tok_emo_re" E; then
    report "$bin: contains banned tool token '$tok_emo'"
  fi
}

# --- main --------------------------------------------------------------------

if [ "$#" -eq 0 ]; then
  fail "usage: $0 --source | <binary> [<binary>...]"
fi

if [ "$1" = "--source" ]; then
  [ "$#" -eq 1 ] || fail "--source takes no additional arguments"
  scan_source
  if [ "$violations" -gt 0 ]; then
    echo "agent-binary-signatures: $violations plaintext threat-signature reference(s) in agent Go source." >&2
    echo "Threat signatures must be obfuscated (XOR fragments decoded at runtime), never plaintext literals — see issue #2797." >&2
    exit 1
  fi
  echo "agent-binary-signatures: OK (no plaintext threat signatures in agent Go source)."
else
  for bin in "$@"; do
    scan_binary "$bin"
  done
  if [ "$violations" -gt 0 ]; then
    echo "agent-binary-signatures: $violations plaintext threat-signature hit(s) in built binaries." >&2
    echo "Shipping these bytes gets the agent flagged as malware by AV engines — see issue #2797." >&2
    exit 1
  fi
  echo "agent-binary-signatures: OK (no plaintext threat signatures in $# scanned binar$( [ "$#" -eq 1 ] && echo y || echo ies))."
fi
