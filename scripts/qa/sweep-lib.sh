# shellcheck shell=bash
# Trusted-side helpers for scripts/qa/scheduled-ui-sweep.sh, sourced by it and by
# scripts/qa/tests/sweep-lib.test.sh. Everything here runs OUTSIDE the agent's
# sandbox and treats whatever the agent wrote as untrusted data: GitHub targets
# are checked against values the runner fixed before the agent started.
#
# Globals the caller sets: QA_HOME, QA_WORKTREE, QA_SOURCE_REPO, RUN_DIR, RUN_ID,
# QA_REPO, NEW_SHA, IN_SCOPE, ENVVALS, STACK_ENV_DIR, STATE, and a log() function.
# macOS /bin/bash is 3.2: no associative arrays, no ${x@Q}.
# shellcheck disable=SC2034  # globals are shared with the runner and the tests

QA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

SECRET_RE='sk_live_|sk_test_|rk_live_|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-'
# body_ok <file>: gate for anything headed to a PUBLIC GitHub sink.
body_ok() {
  [ -s "$1" ] && [ "$(wc -c < "$1")" -le 60000 ] || return 1
  # Byte-wise matching (LC_ALL=C, -a): a NUL or invalid UTF-8 must not turn the
  # file "binary" and hide what follows it from the checks below.
  [ "$(LC_ALL=C tr -d '\000' < "$1" | wc -c)" -eq "$(wc -c < "$1")" ] || return 1
  LC_ALL=C grep -aEq "$SECRET_RE" "$1" && return 1
  # long token-like runs: 40+ chars mixing upper, lower AND digits (JWT/base64/API
  # keys). Hyphenated slugs and 40-hex SHAs don't trip it.
  LC_ALL=C grep -aoE '[A-Za-z0-9+/=_-]{40,}' "$1" | grep '[A-Z]' | grep '[a-z]' | grep -q '[0-9]' && return 1
  LC_ALL=C grep -aEq '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@' "$1" && return 1  # creds in URLs
  [ -s "$ENVVALS" ] && LC_ALL=C grep -aqF -f "$ENVVALS" "$1" && return 1       # any literal .env value
  return 0
}
# text_ok <string>: body_ok + refs_ok for a single field (an issue title), via a private file.
text_ok() {
  local tf rc
  tf="$(mktemp "${PUBLISH_DIR:-$QA_HOME}/.field.XXXXXX")" || return 1
  printf '%s' "$1" > "$tf"; body_ok "$tf" && refs_ok "$tf"; rc=$?
  rm -f "$tf"; return "$rc"
}
# refs_ok <file>: provenance gate for agent-written text bound for GitHub. The
# agent can read GitHub only through the gh broker, which is pinned to QA_REPO,
# so text that names ANOTHER repository (URL, OWNER/REPO#N, OWNER/REPO@sha) did
# not come from a read it was allowed to make. The whole text is scanned: code
# blocks get no exemption, because deciding what GitHub renders as code is
# exactly the guess this gate must not depend on.
refs_ok() {
  local own r
  own="$(printf '%s' "$QA_REPO" | tr '[:upper:]' '[:lower:]')"
  [ -n "${own%%/*}" ] || return 1
  for r in $(LC_ALL=C grep -aoiE 'api\.github\.com/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|(github\.com|githubusercontent\.com)/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' "$1" \
             | sed -E 's#^[Aa][Pp][Ii]\.[^/]*/[Rr][Ee][Pp][Oo][Ss]/##; s#^[^/]*/##' | tr '[:upper:]' '[:lower:]' | sed -E 's/\.+$//; s/\.git$//'); do
    [ "$r" = "$own" ] || return 1
  done
  for r in $(LC_ALL=C grep -aoE '(^|[^A-Za-z0-9_./-])[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+(#[0-9]+|@[0-9a-f]{7,40})' "$1" \
             | sed -E 's#^[^A-Za-z0-9]##; s/[#@].*$//' | tr '[:upper:]' '[:lower:]'); do
    [ "$r" = "$own" ] || return 1
  done
  return 0
}
# neutralize_refs <file>: rewrite text in place so GitHub cannot turn it into a
# notification or a cross-repository backlink, wherever it lands in the markdown.
# A zero-width joiner goes after every @, after anything shaped like an HTML
# entity (GitHub decodes &#64; before it looks for mentions), after the # of a
# reference glued to a preceding token (OWNER/REPO#N, including escaped forms),
# and inside any GitHub host not followed by a plain path into QA_REPO. A bare #N
# stays live: it can only point at QA_REPO. Runs after body_ok/refs_ok, on the
# runner's private copy, and a failure means the text is not published.
neutralize_refs() {
  /usr/bin/python3 -I - "$1" "$QA_REPO" <<'PY'
import re, sys

path, repo = sys.argv[1], sys.argv[2].lower().encode()
if repo.count(b"/") != 1:
    sys.exit(1)
ZWJ = b"\xe2\x80\x8d"
own_path = re.compile(rb"/" + re.escape(repo) + rb"(?:[/?#.,;:!]|$)")

def host(m):
    name, tail = m.group(1), m.group(2)
    low = tail.lower()
    if own_path.match(low) and not re.search(rb"\.\.|%|\\|//", low):
        return m.group(0)
    return name[:-4] + ZWJ + name[-4:] + tail

with open(path, "rb") as f:
    text = f.read()
text = re.sub(rb"(?i)(github\.com|githubusercontent\.com)([^\s<>()\[\]\"'`]*)", host, text)
text = re.sub(rb"&(?=#[0-9xX]|[A-Za-z][A-Za-z0-9]{1,31};)", b"&" + ZWJ, text)
text = text.replace(b"@", b"@" + ZWJ)
text = re.sub(rb"(?<=[^\s(\[])#(?=[0-9])", b"#" + ZWJ, text)
with open(path, "wb") as f:
    f.write(text)
PY
}
# neutral_text <string>: neutralize_refs for a single field (an issue title).
neutral_text() {
  local tf rc
  tf="$(mktemp "${PUBLISH_DIR:-$QA_HOME}/.field.XXXXXX")" || return 1
  printf '%s' "$1" > "$tf"; neutralize_refs "$tf" && cat "$tf"; rc=$?
  rm -f "$tf"; return "$rc"
}

# ---------------------------------------------------------------------------
# Agent sandbox (Seatbelt). Applied with sandbox-exec to the whole agent process
# tree: claude, its Bash commands (gh), the Playwright MCP server and Chromium.
# Unlike Claude Code permission rules, it binds every tool and every child
# process, and the agent cannot change it once started.
#   - network: three loopback ports only -- the QA stack (Caddy), the egress
#     proxy and the gh broker -- so no other service listening on this Mac's
#     loopback is reachable. Unix sockets are denied too (except the agent's own
#     TMPDIR), which also blocks DNS (mDNSResponder), docker.sock and ssh-agent;
#     hostname lookups for the proxy's upstreams happen in the proxy.
#   - secrets: env files (parked or not), the redaction list, machine overrides,
#     ~/.ssh, git credential files, the egress audit log, other runs and this
#     run's logs/transcripts are unreadable.
#   - writes: only RUN_DIR (minus the runner's inputs, its logs/transcripts and
#     any .claude/CLAUDE.md) and the usual caches; the worktree, the developer
#     checkout, runner state and persistence points (~/.claude config, git and gh
#     config, shell rc files, LaunchAgents) are read-only.
#   - GitHub: the agent has NO route to it (not on the egress allowlist) and
#     cannot read gh's config/token store. Its only reader is qa-gh, a client of
#     the runner's gh broker (gh-broker.py), which runs outside the sandbox,
#     allows read-only issue/PR queries and pins every one to QA_REPO.
#   - well-known credential stores (~/.aws, ~/.kube, ~/.docker, ~/.gnupg, ...)
#     and the developer's real browser profiles are unreadable as well.
# ---------------------------------------------------------------------------
_sb_real() {   # _sb_real <path>: physical path (parent must exist), refuses quotes/newlines
  local d b; d="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || return 1
  b="$(basename "$1")"; [ "$b" = / ] && b=""
  case "$d/$b" in *'"'*|*$'\n'*|*'\'*) return 1 ;; esac
  printf '%s' "${d%/}/$b"
}
_sb_re() { printf '%s' "$1" | sed -e 's/[]*.[^$(){}?+|]/\\&/g'; }   # regex-escape a path ("[." would open a BSD collating element)
# _sb_ancestors <path...>: a (literal) rule for each path and every directory
# above it. Seatbelt matches the path at access time, so renaming a parent would
# carry a protected file out from under its rule. Creating children stays allowed.
_sb_ancestors() {
  local p
  for p in "$@"; do
    while [ -n "$p" ] && [ "$p" != / ]; do printf '  (literal "%s")\n' "$p"; p="$(dirname "$p")"; done
  done | sort -u
}
# egress_log_path: the proxy's audit trail. Outside RUN_DIR (the agent's scratch
# space) and denied to the agent in qa_sandbox_profile.
egress_log_path() { printf '%s' "$QA_HOME/.audit/egress-$RUN_ID.log"; }

qa_sandbox_profile() {  # qa_sandbox_profile <out-file>
  local out="$1" home qh wt src run st sed_env atmp gitc audit lib p
  home="$(_sb_real "$HOME")" && qh="$(_sb_real "$QA_HOME")" && wt="$(_sb_real "$QA_WORKTREE")" \
    && src="$(_sb_real "$QA_SOURCE_REPO")" && run="$(_sb_real "$RUN_DIR")" \
    && atmp="$(_sb_real "${AGENT_TMP:-$QA_HOME/.t}")" \
    && st="$(_sb_real "$STACK_ENV_DIR")" && sed_env="$(_sb_real "$ENVVALS")" \
    && lib="$(_sb_real "$QA_LIB_DIR")" || { log "sandbox: bad path"; return 1; }
  # The agent's network is these three loopback ports and nothing else.
  for p in "${QA_STACK_PORT:-}" "${EGRESS_PORT:-}" "${GH_BROKER_PORT:-}"; do
    [[ "$p" =~ ^[0-9]{1,5}$ ]] || { log "sandbox: stack/proxy/broker port missing or bad ('$p')"; return 1; }
  done
  audit="$qh/.audit"
  # The shared git dir: a checkout that is a linked worktree keeps config and hooks there.
  gitc="$(cd "$src" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .git)" 2>/dev/null && pwd -P)"
  gitc="$(_sb_real "${gitc:-$src/.git}")" || { log "sandbox: bad git dir"; return 1; }
  local wt_re src_re run_re home_re locked
  wt_re="$(_sb_re "$wt")"; src_re="$(_sb_re "$src")"; run_re="$(_sb_re "$run")"; home_re="$(_sb_re "$home")"
  locked="$(_sb_ancestors "$run" "$audit" "$wt" "$src" "$gitc" "$lib" "$home/.config/gh" "$home/.config/git" \
    "$home/.claude/skills" "$home/.ssh" "$home/Library/LaunchAgents")"
  ( umask 077; cat > "$out" ) <<SB
(version 1)
(allow default)

;; network: three loopback ports -- the QA stack, the egress proxy, the gh broker
(deny network-outbound)
(allow network-outbound
  (remote ip "localhost:$QA_STACK_PORT")
  (remote ip "localhost:$EGRESS_PORT")
  (remote ip "localhost:$GH_BROKER_PORT"))
;; unix sockets only in the agent's own TMPDIR (Playwright <-> Chromium)
(allow network-outbound (remote unix-socket (subpath "$atmp")))

;; secrets: unreadable (and unwritable) by every process in the tree
(deny file-read* file-write*
  (subpath "$st")
  (literal "$sed_env")
  (literal "$qh/env.overrides")
  (subpath "$qh/.sandbox")
  (subpath "$qh/.publish")
  (subpath "$audit")
  (regex #"^$wt_re/(.*/)?\.env[^/]*$")
  (regex #"^$src_re/(.*/)?\.env[^/]*$")
  (literal "$home/.git-credentials")
  (literal "$home/.config/git/credentials")
  (subpath "$home/.ssh")
  (subpath "$home/.config/gh")
  (subpath "$home/.aws")
  (subpath "$home/.kube")
  (subpath "$home/.docker")
  (subpath "$home/.gnupg")
  (subpath "$home/.password-store")
  (subpath "$home/.config/gcloud")
  (subpath "$home/.azure")
  (literal "$home/.netrc")
  (subpath "$home/Library/Cookies")
  (subpath "$home/Library/Application Support/Google/Chrome")
  (subpath "$home/Library/Application Support/Firefox")
  (subpath "$home/Library/Safari"))
;; contents only (file-read-data): RUN_DIR's parent must stay stat-able, or
;; claude cannot resolve --add-dir / its Edit rules for RUN_DIR
(deny file-read-data
  (require-all (subpath "$qh/runs") (require-not (subpath "$run")))
  (regex #"^$run_re/[^/]*\.(log|err)$")
  (regex #"^$run_re/transcript[^/]*$"))

;; read-only: the worktree, runner state, this run's trusted inputs, and the
;; places a planted file would outlive the run
(deny file-write*
$locked
  (subpath "$wt")
  (subpath "$src")
  (subpath "$gitc")
  (literal "$home/.gitconfig")
  (subpath "$home/.config/git")
  (subpath "$home/.config/gh")
  (subpath "$qh/bin")
  (subpath "$lib")
  (literal "$(_sb_real "$STATE")")
  (literal "$run/commits.tsv")
  (literal "$run/hosted-prs.txt")
  (literal "$run/mcp.json")
  (literal "$run/env-drift.md")
  (literal "$run/env-fingerprint.txt")
  (literal "$run/result")
  (subpath "$run/.claude")
  (regex #"^$run_re/[^/]*\.(log|err)$")
  (regex #"^$run_re/transcript[^/]*$")
  (regex #"^$run_re/(.*/)?CLAUDE(\.local)?\.md$")
  (subpath "$home/.claude/skills")
  (subpath "$home/.claude/commands")
  (subpath "$home/.claude/agents")
  (subpath "$home/.claude/hooks")
  (subpath "$home/.claude/plugins")
  (regex #"^$home_re/\.claude/(settings[^/]*\.json|CLAUDE\.md)$")
  (regex #"^$home_re/\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile)$")
  (subpath "$home/Library/LaunchAgents"))
SB
}

# ---------------------------------------------------------------------------
# Egress proxy: the only route off the machine for traffic the sandboxed process
# tree originates. CONNECT to :443 of a fixed host allowlist (Anthropic, for the
# model only); all else is refused and logged to egress_log_path, which the agent
# cannot touch. GitHub is deliberately NOT on it: the agent reads GitHub only
# through the gh broker below, which runs outside the sandbox and pins the repo.
# The QA stack's own containers are bounded separately (isolate_stack): they
# run on an internal-only Docker network, so the app the agent administers
# cannot be told to call out either.
# ---------------------------------------------------------------------------
QA_EGRESS_ALLOW="${QA_EGRESS_ALLOW:-api.anthropic.com,.anthropic.com,.claude.com,claude.ai,.claude.ai}"
EGRESS_PID=""; EGRESS_PORT=""; EGRESS_LOG=""
# _start_daemon <port-var> <pid-var> <port-file> <cmd...>: start a loopback
# helper that writes its port to <port-file>, and wait for it.
_start_daemon() {
  local pv="$1" pidv="$2" pf="$3" port _; shift 3
  rm -f "$pf"
  "$@" &
  printf -v "$pidv" '%s' "$!"
  for _ in $(seq 1 50); do [ -s "$pf" ] && break; sleep 0.1; done
  port="$(tr -dc '0-9' < "$pf" 2>/dev/null)"
  printf -v "$pv" '%s' "$port"
  [ -n "$port" ] && kill -0 "${!pidv}" 2>/dev/null
}
start_egress_proxy() {
  EGRESS_LOG="$(egress_log_path)"
  ( umask 077; mkdir -p "$QA_HOME/.sandbox" "$(dirname "$EGRESS_LOG")" && : >> "$EGRESS_LOG" ) || return 1
  _start_daemon EGRESS_PORT EGRESS_PID "$QA_HOME/.sandbox/egress.port" \
    /usr/bin/python3 "$QA_LIB_DIR/egress-proxy.py" --allow "$QA_EGRESS_ALLOW" \
    --port-file "$QA_HOME/.sandbox/egress.port" --log "$EGRESS_LOG" || { stop_egress_proxy; return 1; }
  log "egress proxy on 127.0.0.1:$EGRESS_PORT (allow: $QA_EGRESS_ALLOW; audit log: $EGRESS_LOG)"
}
stop_egress_proxy() {
  [ -n "$EGRESS_PID" ] && kill "$EGRESS_PID" 2>/dev/null
  EGRESS_PID=""; EGRESS_PORT=""
}

# gh broker: the agent's only GitHub reader (qa-gh -> gh-broker.py). Runs as
# the runner, outside the sandbox; read-only issue/PR verbs, every call pinned
# to QA_REPO, each request logged next to the egress log.
GH_BROKER_PID=""; GH_BROKER_PORT=""; GH_BROKER_LOG=""
gh_broker_log_path() { printf '%s' "$QA_HOME/.audit/gh-$RUN_ID.log"; }
start_gh_broker() {
  local gh_bin; gh_bin="${QA_GH_BIN:-$(command -v gh)}" || return 1
  [ -n "$gh_bin" ] || return 1
  GH_BROKER_LOG="$(gh_broker_log_path)"
  ( umask 077; mkdir -p "$QA_HOME/.sandbox" "$(dirname "$GH_BROKER_LOG")" && : >> "$GH_BROKER_LOG" ) || return 1
  _start_daemon GH_BROKER_PORT GH_BROKER_PID "$QA_HOME/.sandbox/gh-broker.port" \
    /usr/bin/python3 "$QA_LIB_DIR/gh-broker.py" --repo "$QA_REPO" --gh "$gh_bin" \
    --port-file "$QA_HOME/.sandbox/gh-broker.port" --log "$GH_BROKER_LOG" || { stop_gh_broker; return 1; }
  log "gh broker on 127.0.0.1:$GH_BROKER_PORT (repo: $QA_REPO; audit log: $GH_BROKER_LOG)"
}
stop_gh_broker() {
  [ -n "$GH_BROKER_PID" ] && kill "$GH_BROKER_PID" 2>/dev/null
  GH_BROKER_PID=""; GH_BROKER_PORT=""
}

# build_agent_cmd <cmd...>: AGENT_CMD = <cmd> wrapped in the sandbox, with the
# proxy as its only egress and the gh broker as its only GitHub reader. Needs
# AGENT_PROFILE, EGRESS_PORT and GH_BROKER_PORT.
build_agent_cmd() {
  local px="http://127.0.0.1:$EGRESS_PORT"
  AGENT_CMD=(/usr/bin/sandbox-exec -f "$AGENT_PROFILE"
    /usr/bin/env -u SSH_AUTH_SOCK -u GPG_AGENT_INFO -u DOCKER_HOST
    -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN
    "HTTPS_PROXY=$px" "https_proxy=$px" "HTTP_PROXY=$px" "http_proxy=$px"
    "ALL_PROXY=$px" "NO_PROXY=localhost,127.0.0.1,::1" "no_proxy=localhost,127.0.0.1,::1"
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
    "TMPDIR=${AGENT_TMP:-$QA_HOME/.t}"
    "QA_GH_PORT=$GH_BROKER_PORT"
    "$@")
}

# sandbox_selfcheck: prove the sandbox holds on THIS machine before an agent
# runs under it (fail closed). Needs AGENT_PROFILE, the proxy, the gh broker
# and QA_STACK_PORT. Every "must fail" probe has a control that must succeed
# outside the sandbox, so a probe that could never succeed proves nothing.
sandbox_selfcheck() {
  local fails="" canary="$QA_WORKTREE/.env.qa-sandbox-canary" lp lpid out
  sbx() { /usr/bin/sandbox-exec -f "$AGENT_PROFILE" "$@"; }
  tcp() { "$@" /usr/bin/python3 -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5).close()' "$PORT" 2>/dev/null; }
  dns() { "$@" /usr/bin/python3 -c 'import socket; socket.getaddrinfo("api.anthropic.com", 443)' >/dev/null 2>&1; }
  echo "QA_SANDBOX_CANARY=1" > "$canary"
  sbx /bin/cat "$canary" >/dev/null 2>&1 && fails="$fails env-file-readable"
  rm -f "$canary"
  [ -e "$ENVVALS" ] && sbx /bin/cat "$ENVVALS" >/dev/null 2>&1 && fails="$fails envvals-readable"
  [ -e "$HOME/.config/gh" ] && sbx /bin/ls "$HOME/.config/gh" >/dev/null 2>&1 && fails="$fails gh-config-readable"
  sbx /usr/bin/curl --noproxy '*' -s -m 5 -o /dev/null https://1.1.1.1 2>/dev/null && fails="$fails direct-egress"
  # DNS: a name that resolves outside must not resolve inside.
  if dns env; then dns sbx && fails="$fails dns"; else fails="$fails dns-probe-inconclusive"; fi
  sbx /usr/bin/curl -s -m 10 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://example.com 2>/dev/null && fails="$fails proxy-open"
  sbx /usr/bin/curl -s -m 10 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://api.github.com/zen 2>/dev/null && fails="$fails proxy-allows-github"
  sbx /usr/bin/curl -s -m 15 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://api.anthropic.com/ 2>/dev/null || fails="$fails proxy-blocks-anthropic"
  # loopback: the stack port connects; any other listener on this Mac does not.
  PORT="$QA_STACK_PORT" tcp sbx || fails="$fails stack-unreachable"
  lp="$QA_HOME/.sandbox/selfcheck.port"; rm -f "$lp"
  /usr/bin/python3 -c 'import socket,sys,time; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(4); open(sys.argv[1],"w").write(str(s.getsockname()[1])); time.sleep(30)' "$lp" &
  lpid=$!
  for _ in $(seq 1 30); do [ -s "$lp" ] && break; sleep 0.1; done
  if PORT="$(cat "$lp" 2>/dev/null)" tcp env; then
    PORT="$(cat "$lp")" tcp sbx && fails="$fails other-loopback-port-open"
  else fails="$fails loopback-probe-inconclusive"; fi
  { kill "$lpid"; wait "$lpid"; } 2>/dev/null; rm -f "$lp"
  # GitHub: the broker answers, and refuses a request aimed at another repo.
  sbx /usr/bin/env "QA_GH_PORT=$GH_BROKER_PORT" "$QA_LIB_DIR/qa-gh" issue list --limit 1 --json number >/dev/null 2>&1 \
    || fails="$fails gh-broker-unreachable"
  out="$(sbx /usr/bin/env "QA_GH_PORT=$GH_BROKER_PORT" "$QA_LIB_DIR/qa-gh" issue list --repo cli/cli --limit 1 2>&1)"
  case "$out" in *"qa-gh: refused"*) ;; *) fails="$fails gh-broker-not-pinned" ;; esac
  sbx /bin/sh -c ': >> "$1"' _ "$RUN_DIR/commits.tsv" 2>/dev/null && fails="$fails scope-writable"
  [ -f "$EGRESS_LOG" ] || fails="$fails audit-log-missing"
  sbx /bin/sh -c ': >> "$1"' _ "$EGRESS_LOG" 2>/dev/null && fails="$fails audit-log-writable"
  sbx /bin/sh -c ': >> "$1"' _ "$GH_BROKER_LOG" 2>/dev/null && fails="$fails gh-audit-log-writable"
  sbx /bin/sh -c ': > "$1"' _ "$RUN_DIR/.sandbox-selfcheck" 2>/dev/null || fails="$fails run-dir-readonly"
  rm -f "$RUN_DIR/.sandbox-selfcheck"
  if [ -n "$fails" ]; then log "sandbox selfcheck FAILED:$fails"; return 1; fi
  log "sandbox selfcheck OK (env files + gh config unreadable, no direct egress/DNS, proxy enforces allowlist without GitHub, loopback = stack/proxy/broker only, gh broker pinned to $QA_REPO, scope and audit logs read-only, RUN_DIR writable)"
}

# ---------------------------------------------------------------------------
# QA stack egress. The agent administers the stack, and the app exists to call
# destinations its admin supplies (notification webhooks, integrations, ...),
# so the stack must not reach the internet either. After boot, every container
# of the compose project is moved onto an internal-only Docker network (no
# gateway: no outbound TCP/UDP and no external DNS) under its service name; only
# the edge service (Caddy) also keeps the project network, because a published
# port needs a non-internal network. Caddy's upstreams are fixed in its
# Caddyfile and its admin API listens on its own loopback, so nothing the agent
# controls makes it dial out.
# ---------------------------------------------------------------------------
STACK_NET=""
# isolate_stack <project> [edge-service]
isolate_stack() {
  local project="$1" edge="${2:-caddy}" c svc n ids
  STACK_NET="$project-qa-noegress"
  docker network inspect "$STACK_NET" >/dev/null 2>&1 \
    || docker network create --internal --label io.lanternops.qa-sweep=1 "$STACK_NET" >/dev/null || return 1
  [ "$(docker network inspect -f '{{.Internal}}' "$STACK_NET" 2>/dev/null)" = true ] || { log "stack: $STACK_NET is not internal"; return 1; }
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  [ -n "$ids" ] || { log "stack: no containers for project $project"; return 1; }
  for c in $ids; do
    svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")" || return 1
    if ! docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" | tr ' ' '\n' | grep -qxF "$STACK_NET"; then
      docker network connect --alias "$svc" "$STACK_NET" "$c" >/dev/null || { log "stack: could not attach $svc"; return 1; }
    fi
    [ "$svc" = "$edge" ] && continue
    for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"); do
      [ "$n" = "$STACK_NET" ] && continue
      docker network disconnect -f "$n" "$c" >/dev/null || { log "stack: could not detach $svc from $n"; return 1; }
    done
  done
}
# stack_isolation_check <project> <probe-service> [edge-service]: fail closed
# unless every non-edge container sits only on internal networks AND a live probe
# from <probe-service> (needs node) can neither resolve an external name nor open
# a TCP connection to an internet address.
stack_isolation_check() {
  local project="$1" probe="$2" edge="${3:-caddy}" fails="" c svc n pc rc
  for c in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")"
    [ "$svc" = "$edge" ] && continue
    for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"); do
      [ "$(docker network inspect -f '{{.Internal}}' "$n" 2>/dev/null)" = true ] || fails="$fails $svc-on-$n"
    done
  done
  pc="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$probe" | head -1)"
  if [ -z "$pc" ]; then fails="$fails no-running-$probe"
  else
    # exit 0 = isolated, 10 = external DNS answered, 11 = outbound TCP connected
    docker exec "$pc" node -e '
      const net = require("net"), dns = require("dns");
      let done = false; const fin = (c) => { if (!done) { done = true; process.exit(c); } };
      dns.lookup(process.argv[1], (e) => {
        if (!e) return fin(10);
        const s = net.connect(443, process.argv[2]);
        s.on("connect", () => fin(11)); s.on("error", () => fin(0)); setTimeout(() => fin(0), 5000);
      });' example.com 1.1.1.1 >/dev/null 2>&1
    rc=$?
    case "$rc" in 0) ;; 10) fails="$fails $probe-resolves-external-dns" ;; 11) fails="$fails $probe-reaches-internet" ;;
      *) fails="$fails $probe-probe-failed($rc)" ;; esac
  fi
  if [ -n "$fails" ]; then log "stack isolation check FAILED:$fails"; return 1; fi
  log "stack isolation OK (every service but $edge on internal-only network $STACK_NET; $probe: no external DNS, no outbound TCP)"
}
remove_stack_net() {
  [ -n "$STACK_NET" ] && docker network rm "$STACK_NET" >/dev/null 2>&1
  STACK_NET=""
}


# build_mcp_config <base-url> <src-json> <out-json>: per-run Playwright MCP
# config. The server starts in RUN_DIR/browser (with --ignore-roots its cwd is
# its file workspace) and resolves its npm package from the cache only, since
# the sandbox has no route to the registry (prewarm_mcp fills the cache).
# --allowed-origins is navigation hygiene; the sandbox is the egress control.
# --no-sandbox: Chrome's own renderer sandbox can't be applied inside a Seatbelt
# profile (renderers crash), so the Seatbelt profile confines the whole browser
# instead -- every renderer inherits its file and network limits.
build_mcp_config() {
  local origin; origin="$(printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#')"
  # shellcheck disable=SC2016  # $o/$out are jq variables; $0/$1/$@ belong to the sh wrapper
  jq --arg o "$origin" --arg out "$RUN_DIR/browser" '
    .mcpServers.playwright |= (. + {
      command: "/bin/sh",
      args: (["-c", "export npm_config_offline=true; cd \"$1\" || exit 1; shift; exec \"$0\" \"$@\"", .command, $out] + .args
             + ["--allowed-origins", $o, "--output-dir", $out, "--no-sandbox"])
    })' "$2" > "$3"
}
# prewarm_mcp <src-json>: fetch the pinned MCP package into the npx cache (runs
# outside the sandbox, before the agent).
prewarm_mcp() {
  local pkg; pkg="$(jq -r '.mcpServers.playwright.args[] | select(startswith("@playwright/mcp@"))' "$1" | head -1)"
  [ -n "$pkg" ] || return 1
  npx -y "$pkg" --version >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Outbox publisher
# ---------------------------------------------------------------------------
# snapshot_commentable_issues: the issues an outbox `comment` may target, fixed
# before the agent starts = open qa-sweep issues in QA_REPO right now. Empty on
# failure, which rejects every comment.
snapshot_commentable_issues() {
  QA_COMMENTABLE=" $(gh -R "$QA_REPO" issue list --label qa-sweep --state open --limit 1000 --json number --jq '.[].number' 2>/dev/null \
                     | grep -E '^[0-9]{1,7}$' | tr '\n' ' ')"
  [ "$QA_COMMENTABLE" = " " ] && QA_COMMENTABLE=""
  return 0
}

# snapshot_outbox: copy the agent's outbox into a runner-owned directory and
# publish from there, so nothing the agent left running (or a symlink) can swap
# an entry between validation and use. Unsafe names and non-regular files are
# dropped.
snapshot_outbox() {
  PUBLISH_DIR="$QA_HOME/.publish/$RUN_ID"
  rm -rf "$PUBLISH_DIR"; ( umask 077; mkdir -p "$PUBLISH_DIR" ) || return 1
  local f name n=0
  for f in "$RUN_DIR"/outbox/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="${f##*/}"
    if [ -L "$f" ] || [ ! -f "$f" ]; then log "outbox REJECT $name: not a regular file"; continue; fi
    if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$ ]]; then
      log "outbox REJECT (unsafe name): $(printf '%q' "$name" | cut -c1-120)"; continue
    fi
    n=$((n+1))
    if [ "$n" -gt "${QA_MAX_OUTBOX:-300}" ]; then log "outbox REJECT $name: over ${QA_MAX_OUTBOX:-300} entries"; continue; fi
    if [ "$(wc -c < "$f")" -gt 120000 ]; then log "outbox REJECT $name: oversized"; continue; fi
    cp -p "$f" "$PUBLISH_DIR/$name" || log "outbox REJECT $name: copy failed"
  done
}

publish_outbox() {
  snapshot_outbox || { log "outbox: could not create the publish directory; nothing published"; return 1; }
  gh -R "$QA_REPO" label create qa-sweep --color C5DEF5 --description "Found by the scheduled UI QA sweep" >/dev/null 2>&1 || true
  gh -R "$QA_REPO" label create qa-swept --color 0E8A16 --description "Merged PR checked in the browser by the scheduled UI QA sweep (see QA comment)" >/dev/null 2>&1 || true
  gh -R "$QA_REPO" label create qa-no-ui --color EDEDED --description "Merged PR reviewed by the scheduled QA sweep: no UI surface to test" >/dev/null 2>&1 || true
  # Rejections name the outbox file, never the agent-written value: a refused
  # field may be the very secret the gate caught.
  local created=0 comments=0 prs=0 f action title full_title issue labels bodyf pr result
  local max_comments="${QA_MAX_COMMENTS:-20}"
  # One verdict per PR: if both phases wrote a pr_result for the same PR (e.g. a
  # BLOCKED from the self-hosted phase, then the hosted check), the newest wins.
  local keep="$PUBLISH_DIR/.pr-keep"
  # shellcheck disable=SC2045  # mtime order needs ls; snapshot_outbox allows [A-Za-z0-9._-] names only
  for f in $(ls -1tr "$PUBLISH_DIR"/*.json 2>/dev/null); do
    [ "$(jq -r '.action // empty' "$f" 2>/dev/null)" = pr_result ] && printf '%s %s\n' "$(jq -r '.pr' "$f")" "$f"
  done | awk '{last[$1]=$2} END {for (k in last) print last[k]}' > "$keep"
  for f in "$PUBLISH_DIR"/*.json; do
    [ -f "$f" ] || continue
    if [ "$(jq -r '.action // empty' "$f" 2>/dev/null)" = pr_result ] && ! grep -qxF "$f" "$keep"; then
      log "outbox SKIP $(basename "$f"): superseded by a newer verdict for the same PR"; continue
    fi
    action="$(jq -r '.action // empty' "$f" 2>/dev/null)"
    bodyf="$f.body.md"; jq -r '.body // empty' "$f" > "$bodyf" 2>/dev/null
    if ! body_ok "$bodyf"; then
      log "outbox REJECT $(basename "$f"): empty/oversized/secret-like body"; continue
    fi
    if ! refs_ok "$bodyf"; then
      log "outbox REJECT $(basename "$f"): body references another repository"; continue
    fi
    if ! neutralize_refs "$bodyf"; then
      log "outbox REJECT $(basename "$f"): could not neutralise the body"; continue
    fi
    case "$action" in
      create)
        full_title="$(jq -r '.title // empty' "$f" | tr -d '\n')"
        title="$(printf '%s' "$full_title" | cut -c1-200)"
        if [ "$created" -ge "$MAX_NEW_ISSUES" ] || ! printf '%s' "$title" | grep -Eq '^\[(UI|QA)\] .{5,}'; then
          log "outbox REJECT $(basename "$f"): cap reached or bad title"; continue
        fi
        # Same gate as the body, on the joined title before the cut: a key that
        # straddles column 200 must not publish its first half.
        if ! text_ok "$full_title"; then
          log "outbox REJECT $(basename "$f"): secret-like title (or a cross-repo reference)"; continue
        fi
        title="$(neutral_text "$title")" || { log "outbox REJECT $(basename "$f"): could not neutralise the title"; continue; }
        gh -R "$QA_REPO" issue create --title "$title" --body-file "$bodyf" --label qa-sweep && created=$((created+1)) ;;
      comment)
        issue="$(jq -r '.issue // empty' "$f")"
        [[ "$issue" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad issue"; continue; }
        # Target must be in the snapshot taken before the agent ran ...
        case "$QA_COMMENTABLE" in *" $issue "*) ;; *) log "outbox REJECT $(basename "$f"): #$issue was not an open qa-sweep issue at run start"; continue ;; esac
        [ "$comments" -lt "$max_comments" ] || { log "outbox REJECT $(basename "$f"): comment cap ($max_comments) reached"; continue; }
        # ... and still open + labelled now.
        labels="$(gh -R "$QA_REPO" issue view "$issue" --json labels,state --jq 'select(.state=="OPEN")|[.labels[].name]|join(",")' 2>/dev/null)"
        case ",$labels," in *,qa-sweep,*) gh -R "$QA_REPO" issue comment "$issue" --body-file "$bodyf" && comments=$((comments+1)) ;;
          *) log "outbox REJECT $(basename "$f"): #$issue is not an open qa-sweep issue" ;; esac ;;
      pr_result)
        pr="$(jq -r '.pr // empty' "$f")"; result="$(jq -r '.result // empty' "$f")"
        [[ "$pr" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad pr"; continue; }
        # IN_SCOPE is shell memory captured before the agent ran; commits.tsv is never re-read.
        case "$IN_SCOPE" in *" $pr "*) ;; *) log "outbox REJECT $(basename "$f"): PR #$pr not in this run's commit range"; continue ;; esac
        if [ "$result" = NO_UI ]; then
          gh -R "$QA_REPO" pr edit "$pr" --add-label qa-no-ui >/dev/null && prs=$((prs+1)); continue
        fi
        case "$result" in PASS|PARTIAL|FAIL|BLOCKED) ;; *) log "outbox REJECT $(basename "$f"): bad result"; continue ;; esac
        # One QA comment per PR per main SHA (a re-run of the same range doesn't double-post).
        if gh -R "$QA_REPO" pr view "$pr" --json comments --jq '.comments[].body' 2>/dev/null | grep -qF "<!-- breeze-qa-sweep main=${NEW_SHA:0:9} -->"; then
          log "outbox SKIP pr #$pr: already annotated for this sweep"; continue
        fi
        { printf '<!-- breeze-qa-sweep main=%s -->\n### Scheduled UI QA: %s\n_Checked on main@%s (%s)._\n\n' \
            "${NEW_SHA:0:9}" "$result" "${NEW_SHA:0:9}" "$RUN_ID"; cat "$bodyf"; } > "$bodyf.pr"
        gh -R "$QA_REPO" pr comment "$pr" --body-file "$bodyf.pr" >/dev/null && gh -R "$QA_REPO" pr edit "$pr" --add-label qa-swept >/dev/null && prs=$((prs+1)) ;;
      *) log "outbox REJECT $(basename "$f"): unknown action" ;;
    esac
  done
  log "outbox: $created issue(s) created, $comments comment(s), $prs PR(s) annotated"
  local ledger="$PUBLISH_DIR/ledger.md"
  if [ -f "$RUN_DIR/ledger.md" ] && [ ! -L "$RUN_DIR/ledger.md" ]; then cp "$RUN_DIR/ledger.md" "$ledger"; fi
  if [ -s "$ledger" ] && body_ok "$ledger" && refs_ok "$ledger" && neutralize_refs "$ledger"; then
    local n; n="$(gh -R "$QA_REPO" issue list --label qa-sweep --state open --search 'QA sweep ledger in:title' --json number,title \
                 --jq '[.[]|select(.title=="QA sweep ledger")][0].number // empty')"
    if [ -n "$n" ]; then gh -R "$QA_REPO" issue edit "$n" --body-file "$ledger" >/dev/null
    else gh -R "$QA_REPO" issue create --title "QA sweep ledger" --label qa-sweep --body-file "$ledger" >/dev/null; fi
    log "ledger updated"
  fi
}
