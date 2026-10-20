#!/usr/bin/env bash
# Mechanical hostile-intent screen for an external PR. Prints what the diff
# COULD do that the body may not say. It does not judge; a human (or the Tier 2
# reviewer prompt) reads the hits. Run on every external PR before any tier
# decision, including "green-on-sight" ones.
#
#   pr-threat-screen.sh <PR number> [--repo owner/name]
#
# Exit code is always 0; the report is the output. Known noise: 'tests removed'
# fires on any removed line containing it(/describe(, including code that MOVED
# to another file (#8782); '.repeat(' trips the timers regex; em-dashes and §
# in string literals trip the non-ASCII check. Read the hit, don't count it. Sections print only when
# they have hits, so an empty report after the header means "no mechanical
# signals", not "safe".
set -uo pipefail
PR="${1:?PR number}"; shift || true
REPO="LanternOps/breeze"
while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift 2;; *) shift;; esac; done

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh pr view "$PR" --repo "$REPO" --json author,title,headRepositoryOwner,headRefName,files \
  --jq '{a:.author.login,t:.title,o:.headRepositoryOwner.login,b:.headRefName,f:[.files[].path]}' > "$TMP/meta.json" || { echo "cannot read PR #$PR"; exit 0; }
gh pr diff "$PR" --repo "$REPO" > "$TMP/diff" 2>/dev/null || { echo "cannot fetch diff for #$PR"; exit 0; }
grep -E '^\+' "$TMP/diff" | grep -vE '^\+\+\+' > "$TMP/added" || true

author=$(jq -r .a "$TMP/meta.json"); title=$(jq -r .t "$TMP/meta.json")
fork=$(jq -r .o "$TMP/meta.json"); branch=$(jq -r .b "$TMP/meta.json")
echo "## threat screen #$PR — $author ($fork:$branch)"
echo "   $title"
echo "   files=$(jq '.f|length' "$TMP/meta.json") added-lines=$(wc -l < "$TMP/added" | tr -d ' ')"

section() { # name, file
  if [ -s "$2" ]; then echo; echo "### $1"; sed 's/^/   /' "$2" | cut -c1-220; fi
}

# 1. Sensitive paths
jq -r '.f[]' "$TMP/meta.json" | grep -E \
  '^\.github/|(^|/)Dockerfile|docker-compose|^scripts/|(^|/)package\.json$|pnpm-lock\.yaml|package-lock\.json|go\.(mod|sum)$|Cargo\.(toml|lock)$|/migrations/|^agent/|^apps/(helper|viewer|installer)/|install|updat(e|er)|sign(ing|er)?|auth|sso|oauth|secret|credential|token|crypto|\.env|caddy|nginx|ee/|turbo\.json|tsconfig|\.npmrc|\.husky|pre-commit' \
  > "$TMP/paths" || true
section "sensitive paths touched" "$TMP/paths"

# 2. Workflow / CI / build-tooling changes (anything here is a hard second-look)
jq -r '.f[]' "$TMP/meta.json" | grep -E '^\.github/|Dockerfile|docker-compose|^scripts/|\.npmrc|turbo\.json|Makefile|\.husky' > "$TMP/ci" || true
section "CI / build / container files changed" "$TMP/ci"

# 3. Dependency manifest changes
grep -E '^\+\s*"[^"]+":\s*"[^"]+"' "$TMP/diff" > /dev/null 2>&1 && \
awk '/^diff --git/{f=$3} /^\+\s*"[@A-Za-z0-9._\/-]+":\s*"(\^|~|>=|<|npm:|file:|git|http|workspace|latest|[0-9*])/ && f ~ /package\.json$/ {print f": "$0}' "$TMP/diff" > "$TMP/deps" || true
awk '/^diff --git/{f=$3} /^\+\s*(github\.com|golang\.org|google\.golang\.org|gopkg\.in|[a-z0-9.-]+\.[a-z]+\/)/ && f ~ /go\.mod$/ {print f": "$0}' "$TMP/diff" >> "$TMP/deps" || true
awk '/^diff --git/{f=$3} /^\+\s*[a-z0-9_-]+\s*=\s*("|\{)/ && f ~ /Cargo\.toml$/ {print f": "$0}' "$TMP/diff" >> "$TMP/deps" || true
section "dependency manifest additions/changes" "$TMP/deps"

# 4. Lockfile: new/changed package entries + registry integrity check (npm)
awk '/^diff --git/{f=$3} f ~ /pnpm-lock\.yaml$/ && /^\+  [^ ].*@[0-9][^:]*:$/ {gsub(/^\+ +/,""); sub(/:$/,""); print}' "$TMP/diff" | sort -u > "$TMP/lockpkgs" || true
if [ -s "$TMP/lockpkgs" ]; then
  : > "$TMP/lock"
  while read -r spec; do
    name="${spec%@*}"; ver="${spec##*@}"
    # pnpm lock keys look like name@ver or name@ver(peer...) — strip peers
    ver="${ver%%(*}"
    lockint=$(awk -v k="  $spec:" '$0==k{found=1;next} found&&/integrity:/{gsub(/.*integrity: /,"");gsub(/[},].*$/,"");print;exit} found&&/^  [^ ]/{exit}' <(grep -E '^\+' "$TMP/diff" | sed 's/^\+//'))
    regint=$(npm view "$name@$ver" dist.integrity 2>/dev/null | tail -1)
    tarball=$(npm view "$name@$ver" dist.tarball 2>/dev/null | tail -1)
    if [ -z "$regint" ]; then verdict="NOT ON REGISTRY (or npm view failed)";
    elif [ -z "$lockint" ]; then verdict="no integrity line in diff";
    elif [ "$lockint" = "$regint" ]; then verdict="integrity OK";
    else verdict="INTEGRITY MISMATCH lock=$lockint registry=$regint"; fi
    case "$tarball" in ""|https://registry.npmjs.org/*) ;; *) verdict="$verdict; NON-STANDARD TARBALL $tarball";; esac
    echo "$spec — $verdict" >> "$TMP/lock"
  done < "$TMP/lockpkgs"
  section "lockfile package entries (npm registry check)" "$TMP/lock"
fi
awk '/^diff --git/{f=$3} f ~ /go\.sum$/ && /^\+/ {print}' "$TMP/diff" | sed 's/^+//' > "$TMP/gosum" || true
[ -s "$TMP/gosum" ] && { echo; echo "### go.sum additions ($(wc -l < "$TMP/gosum" | tr -d ' ') lines; verify with 'go mod verify' on the head)"; head -20 "$TMP/gosum" | sed 's/^/   /'; }
awk '/^diff --git/{f=$3} f ~ /pnpm-lock\.yaml$/ && /^\+.*(tarball|resolution: \{(tarball|type: git|commit))/ {print}' "$TMP/diff" > "$TMP/locksrc" || true
section "lockfile NON-REGISTRY sources (git/tarball/url)" "$TMP/locksrc"

# 5. Install-time hooks and package.json scripts
awk '/^diff --git/{f=$3} f ~ /package\.json$/ && /^\+\s*"(pre|post)?(install|prepare|publish|pack|uninstall|shrinkwrap)"/ {print f": "$0}' "$TMP/diff" > "$TMP/hooks" || true
awk '/^diff --git/{f=$3} f ~ /package\.json$/ && /^\+\s*"[a-z:-]+":\s*".*(curl|wget|bash -c|sh -c|node -e|eval|\|\s*sh|\|\s*bash)/ {print f": "$0}' "$TMP/diff" >> "$TMP/hooks" || true
section "install hooks / shell-outs in package.json scripts" "$TMP/hooks"

# 6. New outbound hosts
grep -oE 'https?://[A-Za-z0-9._-]+(:[0-9]+)?' "$TMP/added" | sort | uniq -c | sort -rn \
  | grep -vE 'github\.com|githubusercontent|docs\.breezermm\.com|breezermm\.com|2breeze\.app|localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org)|schema\.org|w3\.org|microsoft\.com|graph\.microsoft|login\.microsoftonline|azure\.com|apple\.com|google\.com|googleapis\.com|mozilla\.org|nodejs\.org|npmjs\.(com|org)|go\.dev|golang\.org|pkg\.go\.dev|rust-lang\.org|docs\.rs|crates\.io|owasp\.org|ietf\.org|rfc-editor|wikipedia|stackoverflow|tailwindcss|react\.dev|vitejs|vitest|playwright\.dev|postgresql\.org|redis\.io|docker\.com|nvd\.nist|cve\.org|mitre\.org|stripe\.com|ui\.com|unifi' \
  > "$TMP/hosts" || true
section "outbound hosts in added lines (not on the known list)" "$TMP/hosts"

# 7. Obfuscation / dynamic execution signals
grep -nE '\beval\(|new Function\(|Function\(["'"'"']|child_process|execSync|spawnSync|\bos/exec\b|exec\.Command|syscall\.|unsafe\.|reflect\.|vm\.runIn|import\(\s*[^"'"'"']|require\(\s*[^"'"'"']|atob\(|Buffer\.from\([^,]+,\s*["'"'"']base64|base64\.(Std|Raw)|\\x[0-9a-f]{2}\\x[0-9a-f]{2}|\\u[0-9a-f]{4}\\u[0-9a-f]{4}|String\.fromCharCode|dangerouslySetInnerHTML|innerHTML\s*=' "$TMP/added" \
  | grep -vE '^\S+:\s*\+\s*(//|/\*|\*|#)' > "$TMP/dyn" || true
section "dynamic execution / decoding / raw DOM" "$TMP/dyn"
grep -nE '[A-Za-z0-9+/=]{80,}' "$TMP/added" | grep -vE 'integrity:|sha(256|512)-|\.svg|data:image|\.png|\.ico|lock' > "$TMP/blobs" || true
section "long opaque strings (possible encoded payloads)" "$TMP/blobs"
# non-ASCII in code files (homoglyphs / bidi), excluding locale + docs
awk '/^diff --git/{f=$3} /^\+/ && !/^\+\+\+/ && f !~ /locales\/|\.md$|\.mdx$|\.json$|\.txt$|\.svg$|\.yaml$/ {print f": "$0}' "$TMP/diff" \
  | LC_ALL=C grep -n '[^	 -~]' | grep -vE '^\S+: \+\s*(//|/\*|\*|#)' | head -20 > "$TMP/nonascii" || true
section "non-ASCII in code lines (check for bidi/homoglyph)" "$TMP/nonascii"

# 8. Secrets, env, credentials, crypto, signing, privilege
grep -nE 'process\.env\.|os\.Getenv|std::env::var|SECRET|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD|credential|SECURITY DEFINER|set_config\(.breeze\.scope|runOutsideDbContext|withSystemDbAccessContext|bypassrls|GRANT |ALTER ROLE|superuser|sudo|setuid|LaunchDaemon|SeDebugPrivilege|CreateProcessAsUser|ImpersonateLoggedOnUser|crypto\.(createSign|sign)|ed25519|x509|tls\.Config|InsecureSkipVerify|rejectUnauthorized|NODE_TLS_REJECT|verify=false|--no-verify|allowlist|denylist|isPlatformAdmin|requireRole|auth\.orgCondition' "$TMP/added" \
  | grep -vE '^\S+:\s*\+\s*(//|/\*|\*|#)' | head -60 > "$TMP/priv" || true
section "secrets / env / privilege / crypto / RLS-bypass touches" "$TMP/priv"

# 9. Network listeners, file writes outside the tree, scheduled work
grep -nE 'net\.Listen|http\.ListenAndServe|createServer\(|\.listen\(|WebSocket\(|new WebSocket|fetch\(\s*`?https?://|http\.(Get|Post)\(|os\.WriteFile|ioutil\.WriteFile|fs\.(writeFile|appendFile|chmod|chown)|writeFileSync|os\.Chmod|os\.Remove|RemoveAll|rm -rf|cron|schedule|setInterval|time\.NewTicker|repeat\(' "$TMP/added" \
  | grep -vE '^\S+:\s*\+\s*(//|/\*|\*|#)' | grep -vE '\.test\.|_test\.go' | head -40 > "$TMP/net" || true
section "listeners / outbound calls / file writes / timers" "$TMP/net"

# 10. Tests deleted or skipped
grep -nE '^\-.*(it\(|test\(|describe\(|func Test)' "$TMP/diff" | head -20 > "$TMP/tdel" || true
grep -nE '^\+.*(\.skip\(|xit\(|xdescribe\(|t\.Skip\(|@ts-ignore|@ts-expect-error|eslint-disable|nolint|#\[allow)' "$TMP/diff" | head -20 >> "$TMP/tdel" || true
section "tests removed / skipped / lint suppressed" "$TMP/tdel"

echo; echo "(end of screen #$PR — empty sections mean no mechanical signal, not safe)"
