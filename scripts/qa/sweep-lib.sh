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
  grep -Eq "$SECRET_RE" "$1" && return 1
  # long token-like runs: 40+ chars mixing upper, lower AND digits (JWT/base64/API
  # keys). Hyphenated slugs and 40-hex SHAs don't trip it.
  grep -oE '[A-Za-z0-9+/=_-]{40,}' "$1" | grep '[A-Z]' | grep '[a-z]' | grep -q '[0-9]' && return 1
  grep -Eq '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@' "$1" && return 1  # creds in URLs
  [ -s "$ENVVALS" ] && grep -qF -f "$ENVVALS" "$1" && return 1       # any literal .env value
  return 0
}

# ---------------------------------------------------------------------------
# Agent sandbox (Seatbelt). Applied with sandbox-exec to the whole agent process
# tree: claude, its Bash commands (gh), the Playwright MCP server and Chromium.
# Unlike Claude Code permission rules, it binds every tool and every child
# process, and the agent cannot change it once started.
#   - network: loopback only (the QA stack + the egress proxy). Unix sockets are
#     denied too, which also blocks DNS (mDNSResponder), docker.sock and
#     ssh-agent; hostname lookups for the proxy's upstreams happen in the proxy.
#   - secrets: env files (parked or not), the redaction list, machine overrides,
#     ~/.ssh, other runs and this run's logs/transcripts are unreadable.
#   - writes: only RUN_DIR (minus the runner's inputs and any .claude/CLAUDE.md)
#     and the usual caches; the worktree, runner state and persistence points
#     (~/.claude config, shell rc files, LaunchAgents) are read-only.
# ---------------------------------------------------------------------------
_sb_real() {   # _sb_real <path>: physical path (parent must exist), refuses quotes/newlines
  local d b; d="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || return 1
  b="$(basename "$1")"; [ "$b" = / ] && b=""
  case "$d/$b" in *'"'*|*$'\n'*|*'\'*) return 1 ;; esac
  printf '%s' "${d%/}/$b"
}
_sb_re() { printf '%s' "$1" | sed -e 's/[]*.[^$(){}?+|]/\\&/g'; }   # regex-escape a path ("[." would open a BSD collating element)

qa_sandbox_profile() {  # qa_sandbox_profile <out-file>
  local out="$1" home qh wt src run st sed_env atmp
  home="$(_sb_real "$HOME")" && qh="$(_sb_real "$QA_HOME")" && wt="$(_sb_real "$QA_WORKTREE")" \
    && src="$(_sb_real "$QA_SOURCE_REPO")" && run="$(_sb_real "$RUN_DIR")" \
    && atmp="$(_sb_real "${AGENT_TMP:-$QA_HOME/.t}")" \
    && st="$(_sb_real "$STACK_ENV_DIR")" && sed_env="$(_sb_real "$ENVVALS")" || { log "sandbox: bad path"; return 1; }
  local wt_re src_re run_re home_re
  wt_re="$(_sb_re "$wt")"; src_re="$(_sb_re "$src")"; run_re="$(_sb_re "$run")"; home_re="$(_sb_re "$home")"
  ( umask 077; cat > "$out" ) <<SB
(version 1)
(allow default)

;; network: loopback only -- the QA stack and the runner's egress proxy
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
;; unix sockets only in the agent's own TMPDIR (Playwright <-> Chromium)
(allow network-outbound (remote unix-socket (subpath "$atmp")))

;; secrets: unreadable (and unwritable) by every process in the tree
(deny file-read* file-write*
  (subpath "$st")
  (literal "$sed_env")
  (literal "$qh/env.overrides")
  (subpath "$qh/.sandbox")
  (subpath "$qh/.publish")
  (regex #"^$wt_re/(.*/)?\.env[^/]*$")
  (regex #"^$src_re/(.*/)?\.env[^/]*$")
  (subpath "$home/.ssh"))
;; contents only (file-read-data): RUN_DIR's parent must stay stat-able, or
;; claude cannot resolve --add-dir / its Edit rules for RUN_DIR
(deny file-read-data
  (require-all (subpath "$qh/runs") (require-not (subpath "$run")))
  (regex #"^$run_re/[^/]*\.(log|err)$")
  (regex #"^$run_re/transcript[^/]*$"))

;; read-only: the worktree, runner state, this run's trusted inputs, and the
;; places a planted file would outlive the run
(deny file-write*
  (subpath "$wt")
  (subpath "$qh/bin")
  (literal "$(_sb_real "$STATE")")
  (literal "$run/commits.tsv")
  (literal "$run/hosted-prs.txt")
  (literal "$run/mcp.json")
  (literal "$run/env-drift.md")
  (literal "$run/env-fingerprint.txt")
  (literal "$run/result")
  (subpath "$run/.claude")
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
# Egress proxy: the sandbox's only route off the machine. CONNECT to :443 of a
# fixed host allowlist (Anthropic for the model, GitHub for read-only gh); all
# else is refused and logged to RUN_DIR/egress.log.
# ---------------------------------------------------------------------------
QA_EGRESS_ALLOW="${QA_EGRESS_ALLOW:-api.anthropic.com,.anthropic.com,.claude.com,claude.ai,.claude.ai,api.github.com,github.com}"
EGRESS_PID=""; EGRESS_PORT=""
start_egress_proxy() {
  local pf="$QA_HOME/.sandbox/egress.port"
  ( umask 077; mkdir -p "$QA_HOME/.sandbox" ) || return 1
  rm -f "$pf"
  /usr/bin/python3 "$QA_LIB_DIR/egress-proxy.py" --allow "$QA_EGRESS_ALLOW" --port-file "$pf" --log "$RUN_DIR/egress.log" &
  EGRESS_PID=$!
  local _
  for _ in $(seq 1 50); do [ -s "$pf" ] && break; sleep 0.1; done
  EGRESS_PORT="$(tr -dc '0-9' < "$pf" 2>/dev/null)"
  [ -n "$EGRESS_PORT" ] && kill -0 "$EGRESS_PID" 2>/dev/null || { stop_egress_proxy; return 1; }
  log "egress proxy on 127.0.0.1:$EGRESS_PORT (allow: $QA_EGRESS_ALLOW)"
}
stop_egress_proxy() {
  [ -n "$EGRESS_PID" ] && kill "$EGRESS_PID" 2>/dev/null
  EGRESS_PID=""; EGRESS_PORT=""
}

# build_agent_cmd <cmd...>: AGENT_CMD = <cmd> wrapped in the sandbox, with the
# proxy as its only egress. Needs AGENT_PROFILE and EGRESS_PORT.
build_agent_cmd() {
  local px="http://127.0.0.1:$EGRESS_PORT"
  AGENT_CMD=(/usr/bin/sandbox-exec -f "$AGENT_PROFILE"
    /usr/bin/env -u SSH_AUTH_SOCK -u GPG_AGENT_INFO -u DOCKER_HOST
    "HTTPS_PROXY=$px" "https_proxy=$px" "HTTP_PROXY=$px" "http_proxy=$px"
    "ALL_PROXY=$px" "NO_PROXY=localhost,127.0.0.1,::1" "no_proxy=localhost,127.0.0.1,::1"
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
    "TMPDIR=${AGENT_TMP:-$QA_HOME/.t}"
    "$@")
}

# sandbox_selfcheck: prove the sandbox holds on THIS machine before an agent
# runs under it (fail closed). Needs AGENT_PROFILE and a running proxy.
sandbox_selfcheck() {
  local fails="" canary="$QA_WORKTREE/.env.qa-sandbox-canary"
  sbx() { /usr/bin/sandbox-exec -f "$AGENT_PROFILE" "$@"; }
  echo "QA_SANDBOX_CANARY=1" > "$canary"
  sbx /bin/cat "$canary" >/dev/null 2>&1 && fails="$fails env-file-readable"
  rm -f "$canary"
  [ -e "$ENVVALS" ] && sbx /bin/cat "$ENVVALS" >/dev/null 2>&1 && fails="$fails envvals-readable"
  sbx /usr/bin/curl --noproxy '*' -s -m 5 -o /dev/null https://1.1.1.1 2>/dev/null && fails="$fails direct-egress"
  sbx /usr/bin/python3 -c 'import socket; socket.gethostbyname("qa-sandbox-selfcheck.example.org")' >/dev/null 2>&1 && fails="$fails dns"
  sbx /usr/bin/curl -s -m 10 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://example.com 2>/dev/null && fails="$fails proxy-open"
  sbx /usr/bin/curl -s -m 15 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://api.github.com/zen 2>/dev/null || fails="$fails proxy-blocks-github"
  sbx /bin/sh -c ': >> "$1"' _ "$RUN_DIR/commits.tsv" 2>/dev/null && fails="$fails scope-writable"
  if [ -n "$fails" ]; then log "sandbox selfcheck FAILED:$fails"; return 1; fi
  log "sandbox selfcheck OK (env files unreadable, no direct egress/DNS, proxy enforces allowlist, scope read-only)"
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
  local created=0 comments=0 prs=0 f action title issue labels bodyf pr result
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
    case "$action" in
      create)
        title="$(jq -r '.title // empty' "$f" | tr -d '\n' | cut -c1-200)"
        if [ "$created" -ge "$MAX_NEW_ISSUES" ] || ! printf '%s' "$title" | grep -Eq '^\[(UI|QA)\] .{5,}'; then
          log "outbox REJECT $(basename "$f"): cap reached or bad title '$title'"; continue
        fi
        gh -R "$QA_REPO" issue create --title "$title" --body-file "$bodyf" --label qa-sweep && created=$((created+1)) ;;
      comment)
        issue="$(jq -r '.issue // empty' "$f")"
        [[ "$issue" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad issue '$issue'"; continue; }
        # Target must be in the snapshot taken before the agent ran ...
        case "$QA_COMMENTABLE" in *" $issue "*) ;; *) log "outbox REJECT $(basename "$f"): #$issue was not an open qa-sweep issue at run start"; continue ;; esac
        [ "$comments" -lt "$max_comments" ] || { log "outbox REJECT $(basename "$f"): comment cap ($max_comments) reached"; continue; }
        # ... and still open + labelled now.
        labels="$(gh -R "$QA_REPO" issue view "$issue" --json labels,state --jq 'select(.state=="OPEN")|[.labels[].name]|join(",")' 2>/dev/null)"
        case ",$labels," in *,qa-sweep,*) gh -R "$QA_REPO" issue comment "$issue" --body-file "$bodyf" && comments=$((comments+1)) ;;
          *) log "outbox REJECT $(basename "$f"): #$issue is not an open qa-sweep issue" ;; esac ;;
      pr_result)
        pr="$(jq -r '.pr // empty' "$f")"; result="$(jq -r '.result // empty' "$f")"
        [[ "$pr" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad pr '$pr'"; continue; }
        # IN_SCOPE is shell memory captured before the agent ran; commits.tsv is never re-read.
        case "$IN_SCOPE" in *" $pr "*) ;; *) log "outbox REJECT $(basename "$f"): PR #$pr not in this run's commit range"; continue ;; esac
        if [ "$result" = NO_UI ]; then
          gh -R "$QA_REPO" pr edit "$pr" --add-label qa-no-ui >/dev/null && prs=$((prs+1)); continue
        fi
        case "$result" in PASS|PARTIAL|FAIL|BLOCKED) ;; *) log "outbox REJECT $(basename "$f"): bad result '$result'"; continue ;; esac
        # One QA comment per PR per main SHA (a re-run of the same range doesn't double-post).
        if gh -R "$QA_REPO" pr view "$pr" --json comments --jq '.comments[].body' 2>/dev/null | grep -qF "<!-- breeze-qa-sweep main=${NEW_SHA:0:9} -->"; then
          log "outbox SKIP pr #$pr: already annotated for this sweep"; continue
        fi
        { printf '<!-- breeze-qa-sweep main=%s -->\n### Scheduled UI QA: %s\n_Checked on main@%s (%s)._\n\n' \
            "${NEW_SHA:0:9}" "$result" "${NEW_SHA:0:9}" "$RUN_ID"; cat "$bodyf"; } > "$bodyf.pr"
        gh -R "$QA_REPO" pr comment "$pr" --body-file "$bodyf.pr" >/dev/null && gh -R "$QA_REPO" pr edit "$pr" --add-label qa-swept >/dev/null && prs=$((prs+1)) ;;
      *) log "outbox REJECT $(basename "$f"): unknown action '$action'" ;;
    esac
  done
  log "outbox: $created issue(s) created, $comments comment(s), $prs PR(s) annotated"
  local ledger="$PUBLISH_DIR/ledger.md"
  if [ -f "$RUN_DIR/ledger.md" ] && [ ! -L "$RUN_DIR/ledger.md" ]; then cp "$RUN_DIR/ledger.md" "$ledger"; fi
  if [ -s "$ledger" ] && body_ok "$ledger"; then
    local n; n="$(gh -R "$QA_REPO" issue list --label qa-sweep --state open --search 'QA sweep ledger in:title' --json number,title \
                 --jq '[.[]|select(.title=="QA sweep ledger")][0].number // empty')"
    if [ -n "$n" ]; then gh -R "$QA_REPO" issue edit "$n" --body-file "$ledger" >/dev/null
    else gh -R "$QA_REPO" issue create --title "QA sweep ledger" --label qa-sweep --body-file "$ledger" >/dev/null; fi
    log "ledger updated"
  fi
}
