#!/usr/bin/env bash
# Scheduled, unattended UI QA sweep (ui-qa-sweep skill, "Scheduled mode").
#
# Each run:
#   1. resets a dedicated QA worktree to origin/main (never touches dev checkouts)
#   2. boots an isolated wt-stack for it (rebuilds only when deps/Dockerfiles changed)
#   3. runs headless `claude -p` with an isolated, headless Playwright MCP browser
#   4. tears the stack down, advances the cursor, posts a macOS notification
#
# Installed as a launchd agent by scripts/qa/install-schedule.sh.
# State + reports live outside the repo in $QA_HOME (default ~/.breeze-qa).
#
# Env overrides:
#   QA_HOME            state/report dir                  (default ~/.breeze-qa)
#   QA_WORKTREE        dedicated worktree path           (default $QA_HOME/worktree)
#   QA_SOURCE_REPO     repo to add the worktree from     (default: this script's repo)
#   QA_TIMEOUT         hard wall-clock cap for claude    (default 5h)
#   QA_MODEL           optional --model
#   QA_CLAUDE_AUTH_DIR claude.ai login profile dir (sets CLAUDE_SECURESTORAGE_CONFIG_DIR)
#   QA_MAX_NEW_ISSUES  cap on issues filed per run       (default 10)
#   QA_DRY_RUN=1       do everything except run claude (smoke-tests the plumbing)
#   QA_FORCE=1         run even if origin/main hasn't moved since the last sweep

set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QA_HOME="${QA_HOME:-$HOME/.breeze-qa}"
QA_WORKTREE="${QA_WORKTREE:-$QA_HOME/worktree}"
QA_SOURCE_REPO="${QA_SOURCE_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
QA_TIMEOUT="${QA_TIMEOUT:-5h}"
STATE="$QA_HOME/state.json"
LOCK="$QA_HOME/run.lock"
RUN_ID="$(date -u +%Y-%m-%dT%H%MZ)"
RUN_DIR="$QA_HOME/runs/$RUN_ID"
LOG="$RUN_DIR/runner.log"

mkdir -p "$RUN_DIR"
exec >>"$LOG" 2>&1

notify() {
  # Text goes in as argv, never spliced into AppleScript source (agent-written
  # report text reaches here).
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Breeze QA sweep"' \
    -e 'end run' -- "$(printf '%s' "$1" | tr -cd '[:alnum:] .,:;()/#_=@+-' | cut -c1-200)" 2>/dev/null || true
}
log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
state_get() { [ -f "$STATE" ] && jq -r "$1 // empty" "$STATE" 2>/dev/null; }
state_set() {  # state_set <jq-filter> [--arg k v ...]
  local tmp; tmp="$(mktemp)"
  jq "${@:2}" "$1" <(cat "$STATE" 2>/dev/null || echo '{}') > "$tmp" && mv "$tmp" "$STATE"
}
SECRET_RE='sk_live_|sk_test_|rk_live_|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-'
ENVVALS="$QA_HOME/.envvals"   # literal .env values; outside RUN_DIR so the agent can't read it
# body_ok <file>: gate for anything headed to a PUBLIC GitHub sink.
body_ok() {
  [ -s "$1" ] && [ "$(wc -c < "$1")" -le 60000 ] || return 1
  grep -Eq "$SECRET_RE" "$1" && return 1
  grep -Eq '[A-Za-z0-9+/=_-]{48,}' "$1" && return 1                 # long high-entropy runs
  grep -Eq '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@' "$1" && return 1  # creds in URLs
  [ -s "$ENVVALS" ] && grep -qF -f "$ENVVALS" "$1" && return 1       # any literal .env value
  return 0
}
# Trusted-side issue writer for runner-detected problems: one open issue per
# title (label qa-sweep); repeats become a comment instead of a new issue.
runner_issue() {  # runner_issue <title> <body-file>
  if [ "${QA_DRY_RUN:-0}" = 1 ]; then log "DRY RUN: would file/comment issue: $1 (body: $2)"; return 0; fi
  body_ok "$2" || { log "REFUSED to publish '$1': body failed secret checks (kept locally: $2)"; return 1; }
  gh -R "$QA_REPO" label create qa-sweep --color C5DEF5 --description "Found by the scheduled UI QA sweep" >/dev/null 2>&1 || true
  local n; n="$(gh -R "$QA_REPO" issue list --label qa-sweep --state open --search "\"$1\" in:title" --json number,title 2>/dev/null \
               | jq -r --arg t "$1" '[.[]|select(.title==$t)][0].number // empty')"
  if [ -n "$n" ]; then gh -R "$QA_REPO" issue comment "$n" --body-file "$2" >/dev/null && log "commented on #$n: $1"
  else gh -R "$QA_REPO" issue create --title "$1" --label qa-sweep --body-file "$2" >/dev/null && log "filed: $1"; fi
}

# --- single-flight lock (stale after 8h) ------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +480 2>/dev/null)" ]; then
    log "removing stale lock"; rm -rf "$LOCK"; mkdir "$LOCK"
  else
    log "another sweep is running; exiting"; rmdir "$RUN_DIR" 2>/dev/null; exit 0
  fi
fi
STACK_UP=0
cleanup() {
  if [ "$STACK_UP" = 1 ]; then
    log "tearing down stack"
    (cd "$QA_WORKTREE" && pnpm wt-stack down) || log "WARN: wt-stack down failed"
  fi
  rm -f "$ENVVALS"; rm -rf "$LOCK"
}
trap cleanup EXIT

log "=== QA sweep $RUN_ID ==="

# --- subscription auth only (never API billing) ------------------------------
# An API key / alt provider in the environment silently overrides the claude.ai
# login, so strip them and then require authMethod=claude.ai.
# QA_CLAUDE_AUTH_DIR pins a specific claude.ai login profile (multi-account setups).
[ -n "${QA_CLAUDE_AUTH_DIR:-}" ] && export CLAUDE_SECURESTORAGE_CONFIG_DIR="$QA_CLAUDE_AUTH_DIR"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
      CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
AUTH_METHOD="$(claude auth status --json 2>/dev/null | jq -r '.authMethod // empty')"
if [ "$AUTH_METHOD" != "claude.ai" ]; then
  notify "QA sweep skipped: Claude is not logged in with a subscription (auth=${AUTH_METHOD:-none}). Run: claude auth login"
  log "FATAL auth method '${AUTH_METHOD:-none}', expected claude.ai"; exit 1
fi
log "auth: claude.ai subscription"

# --- docker engine -----------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  log "docker engine down; starting OrbStack"
  (command -v orb >/dev/null && orb start) || open -ga OrbStack
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
  docker info >/dev/null 2>&1 || { notify "QA sweep skipped: Docker engine would not start"; log "FATAL docker"; exit 1; }
fi

# --- dedicated worktree at origin/main --------------------------------------
git -C "$QA_SOURCE_REPO" fetch --quiet origin main || { notify "QA sweep: git fetch failed"; exit 1; }
if [ ! -e "$QA_WORKTREE/.git" ]; then
  log "creating QA worktree at $QA_WORKTREE"
  git -C "$QA_SOURCE_REPO" worktree add -B qa/scheduled-sweep "$QA_WORKTREE" origin/main || exit 1
fi
cd "$QA_WORKTREE" || exit 1
PREV_SHA="$(state_get .lastSweptSha)"
git checkout --quiet -B qa/scheduled-sweep origin/main
git reset --quiet --hard origin/main
git clean -fdq   # keeps ignored files (.env, node_modules)
NEW_SHA="$(git rev-parse HEAD)"
# The skill's Scheduled-mode contract (outbox schema, scope rules) must match THIS
# runner's publisher, not whatever main currently has, so the installer ships them
# together and the runner overlays its copy onto the worktree (reset next run).
if [ -f "$SCRIPT_DIR/ui-qa-sweep.SKILL.md" ]; then
  cp "$SCRIPT_DIR/ui-qa-sweep.SKILL.md" .claude/skills/ui-qa-sweep/SKILL.md
else
  log "WARN: no bundled skill next to runner; using main's (may lack Scheduled mode)"
fi
grep -q '^## Scheduled mode' .claude/skills/ui-qa-sweep/SKILL.md \
  || { notify "QA sweep: skill has no Scheduled mode section - re-run install-schedule.sh"; log "FATAL skill contract missing"; exit 1; }
log "main=$NEW_SHA prev=${PREV_SHA:-none}"
QA_REPO="${QA_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}"
[ -n "$QA_REPO" ] || { notify "QA sweep: could not resolve GitHub repo"; exit 1; }

if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" = "$NEW_SHA" ] && [ "${QA_FORCE:-0}" != 1 ]; then
  log "main unchanged since last sweep; nothing to do"; exit 0
fi

# --- environment: derive from main, detect drift ------------------------------
# The QA stack must run what main says (.env.example, compose, .nvmrc, go.mod),
# not whatever a dev .env happened to pin. Anything that changed since the last
# sweep (e.g. Postgres 16 -> 18) is reported, forces a rebuild, and is filed as
# a [QA] issue so the release's self-hoster upgrade notes can't miss it.
DRIFT="$RUN_DIR/env-drift.md"; : > "$DRIFT"

[ -f .env ] || cp "$QA_SOURCE_REPO/.env" .env 2>/dev/null || { notify "QA sweep: no .env for the QA worktree"; exit 1; }
# Infra *_IMAGE_REF (postgres/redis/caddy/coturn) -> always main's value (image
# pins are main's contract, not a dev preference). BREEZE_* refs are release
# placeholders in .env.example and are built locally in dev, so they're skipped. Other keys are NOT copied from .env.example (placeholder values
# like BREEZE_DOMAIN would break the stack); new keys surface via the fingerprint.
while IFS= read -r line; do
  key="${line%%=*}"
  if [ "$(grep -m1 "^$key=" .env | cut -d= -f2-)" != "${line#*=}" ]; then
    grep -v "^$key=" .env > .env.tmp; printf '%s\n' "$line" >> .env.tmp; mv .env.tmp .env
    log "synced $key to main's value"
  fi
done < <(grep -E '^[A-Z][A-Z0-9_]*_IMAGE_REF=' .env.example | grep -v '^BREEZE_' | grep -v 'replace-with')

# Literal values of every .env entry (>= 8 chars) -> redaction list for public sinks.
( umask 077; grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//' \
    | awk 'length($0) >= 8' | sort -u > "$ENVVALS" )

# Node from .nvmrc (auto-install via nvm if this Mac doesn't have it yet)
NODE_WANT="$(tr -d 'v \n' < .nvmrc 2>/dev/null)"
if [ -n "$NODE_WANT" ] && [ ! -x "$HOME/.nvm/versions/node/v$NODE_WANT/bin/node" ]; then
  log "installing Node $NODE_WANT (from .nvmrc)"
  ( export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" && nvm install "$NODE_WANT" && corepack enable ) >/dev/null 2>&1 \
    || { notify "QA sweep: could not install Node $NODE_WANT from .nvmrc"; exit 1; }
fi
[ -n "$NODE_WANT" ] && export PATH="$HOME/.nvm/versions/node/v$NODE_WANT/bin:$PATH"
command -v pnpm >/dev/null || { notify "QA sweep: pnpm missing for Node $NODE_WANT"; exit 1; }

# Environment fingerprint: image pins, literal compose images, toolchain pins.
FP_FILE="$RUN_DIR/env-fingerprint.txt"
{
  grep -E '^[A-Z0-9_]*_IMAGE_REF=' .env | grep -v '^BREEZE_' | sort
  grep -hE '^[[:space:]]*image:[[:space:]]*[^$[:space:]]' docker-compose.yml docker-compose.override.yml.dev 2>/dev/null \
    | sed -E 's/^[[:space:]]+//' | sort -u
  grep -hE '^FROM ' Dockerfile* docker/*Dockerfile* 2>/dev/null | sort -u
  echo "node=$NODE_WANT"
  grep -m1 -E '^go [0-9]' agent/go.mod 2>/dev/null | sed 's/^/agent-/'
  grep -m1 '"packageManager"' package.json 2>/dev/null | tr -d ' ,'
  grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d = | sort -u | sed 's/^/env-var:/'   # names only
} > "$FP_FILE"
PREV_FP="$(state_get .envFingerprint)"
ENV_CHANGED=0
if [ -n "$PREV_FP" ] && [ "$PREV_FP" != "$(cat "$FP_FILE")" ]; then
  ENV_CHANGED=1
  { echo "- runtime/toolchain pins changed since the last sweep:"; echo '```diff'
    diff <(printf '%s\n' "$PREV_FP") "$FP_FILE" | grep -E '^[<>]' | sed 's/^</-/; s/^>/+/'
    echo '```'; } >> "$DRIFT"
  log "environment fingerprint changed"
fi

# --- deps + stack ------------------------------------------------------------
REBUILD=""
if [ -z "$PREV_SHA" ] || [ "$ENV_CHANGED" = 1 ] || ! git cat-file -e "$PREV_SHA" 2>/dev/null \
   || ! git diff --quiet "$PREV_SHA" "$NEW_SHA" -- pnpm-lock.yaml 'Dockerfile*' 'docker/' 'docker-compose*' .nvmrc; then
  REBUILD="--rebuild"
fi
log "pnpm install"; pnpm install --frozen-lockfile --prefer-offline >/dev/null || { notify "QA sweep: pnpm install failed (see $LOG)"; exit 1; }
log "wt-stack up $REBUILD"
STACK_UP=1
if ! pnpm wt-stack up $REBUILD 2>&1 | tee "$RUN_DIR/stack-up.log"; then :; fi
if [ ! -f .breeze-stack.json ] || ! curl -sf -o /dev/null "$(jq -r .baseUrl .breeze-stack.json 2>/dev/null)/health"; then
  # Boot failure on main is the most important finding a sweep can make.
  PROJECT="$(sed -nE 's/^\[wt-stack\] project=([^ ]+).*/\1/p' "$RUN_DIR/stack-up.log" | head -1)"
  BODY="$RUN_DIR/boot-failure.md"
  { echo "The scheduled QA sweep could not boot the dev stack on \`main@${NEW_SHA:0:9}\` ($RUN_ID)."
    [ -s "$DRIFT" ] && { echo; echo "### Environment changes detected this run"; cat "$DRIFT"; }
    echo; echo "### Container status"; echo '```'
    docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}\t{{.Status}}' 2>/dev/null
    echo '```'
    for c in $(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Status}}' 2>/dev/null \
               | grep -iE 'unhealthy|exited|restarting' | cut -d' ' -f1); do
      docker logs --tail 200 "$c" > "$RUN_DIR/container-$c.log" 2>&1
      # Public excerpt: only error-signature lines, literal .env values stripped,
      # anything still secret-shaped dropped. Full logs stay on the QA Mac.
      echo; echo "### \`$c\` error lines"; echo '```'
      grep -E 'CRITICAL|FATAL|Error:|error:|ERROR' "$RUN_DIR/container-$c.log" | tail -8 | cut -c1-240 \
        | { if [ -s "$ENVVALS" ]; then grep -vF -f "$ENVVALS"; else cat; fi; } \
        | grep -Ev "$SECRET_RE" | grep -Ev '[A-Za-z0-9+/=_-]{48,}|://[^/[:space:]:@]+:[^/[:space:]@]+@'
      echo '```'
    done
    echo; echo "Full container logs and wt-stack output: \`$RUN_DIR\` on the QA Mac."
    echo; echo "_Filed by the scheduled UI QA sweep. The sweep retries on the next run; this issue gets a comment each time it recurs._"
  } > "$BODY"
  runner_issue "[QA] Dev stack fails to boot on main" "$BODY"
  notify "QA sweep: stack would NOT boot on main@${NEW_SHA:0:9} (issue filed) - release blocker"
  echo "STACK_BOOT_FAILED" > "$RUN_DIR/result"; exit 1
fi
if [ -s "$DRIFT" ]; then
  { echo "The scheduled QA sweep detected environment changes on \`main@${NEW_SHA:0:9}\` since the last sweep (\`${PREV_SHA:0:9}\`). The stack booted with them; check the release's **Self-Hosting / Upgrade Notes** cover each one (e.g. a Postgres major-version bump needs a \`pg_upgrade\`/dump-restore path for self-hosters; a new required env var must be mapped in compose)."
    echo; cat "$DRIFT"; echo; echo "_Filed by the scheduled UI QA sweep. Close once the release notes cover it._"
  } > "$RUN_DIR/drift-issue.md"
  [ -n "$PREV_SHA" ] && runner_issue "[QA] Environment change on main needs upgrade notes" "$RUN_DIR/drift-issue.md"
  notify "QA sweep: environment changed on main (see env-drift.md)"
fi
state_set '. + {envFingerprint:$fp}' --rawfile fp "$FP_FILE"
BASE_URL="$(jq -r .baseUrl .breeze-stack.json)"
log "stack at $BASE_URL"

# --- the sweep ---------------------------------------------------------------
SLICE="$(state_get .nextSlice)"; SLICE="${SLICE:-0}"
mkdir -p "$RUN_DIR/outbox" "$RUN_DIR/browser"

# PR scope is computed here (trusted) so the agent needs no git access.
if [ -n "$PREV_SHA" ] && git cat-file -e "$PREV_SHA" 2>/dev/null; then
  git log --first-parent --format='%H%x09%cI%x09%s' "$PREV_SHA..$NEW_SHA" > "$RUN_DIR/commits.tsv"
else
  git log --first-parent --since='3 days ago' --format='%H%x09%cI%x09%s' "$NEW_SHA" > "$RUN_DIR/commits.tsv"
fi
chmod 0444 "$RUN_DIR/commits.tsv"
# PR numbers the agent may annotate = LAST "(#N)" of each in-scope commit.
# Captured in shell memory now, before the agent runs, so it can't widen it.
IN_SCOPE=" $(cut -f3 "$RUN_DIR/commits.tsv" | sed -nE 's/.*\(#([0-9]+)\)[[:space:]]*$/\1/p' | tr '\n' ' ') "
log "commits in scope: $(wc -l < "$RUN_DIR/commits.tsv" | tr -d ' ')"

# Per-run browser config: only the local stack is reachable (no exfil to the
# internet via the browser); file:// stays blocked (Playwright MCP default).
ORIGIN="$(printf '%s' "$BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
jq --arg o "$ORIGIN" --arg out "$RUN_DIR/browser" \
  '.mcpServers.playwright.args += ["--allowed-origins", $o, "--output-dir", $out]' \
  "$SCRIPT_DIR/qa-mcp.json" > "$RUN_DIR/mcp.json"

PROMPT="Run the ui-qa-sweep skill in **Scheduled mode** (read its 'Scheduled mode' section first and follow it exactly).
Run parameters:
- RUN_DIR=$RUN_DIR   (write report.md, ledger.md and outbox/*.json here — nowhere else)
- BASE_URL=$BASE_URL (stack descriptor: $QA_WORKTREE/.breeze-stack.json)
- MAIN_SHA=$NEW_SHA
- PREV_SWEPT_SHA=${PREV_SHA:-none}
- COMMITS_FILE=$RUN_DIR/commits.tsv (first-parent commits in scope: sha, date, subject)
- ROTATION_SLICE=$SLICE
- ENV_DRIFT_FILE=$DRIFT (environment changes detected this run; empty = none)
You are unattended: never ask questions. You cannot write to GitHub directly; queue writes in RUN_DIR/outbox as the skill describes."

if [ "${QA_DRY_RUN:-0}" = 1 ]; then
  log "DRY RUN: skipping claude. prompt was:"; echo "$PROMPT"; cat "$RUN_DIR/mcp.json"
  curl -sf -o /dev/null "$BASE_URL/health" && log "health OK" || log "health FAILED"
  exit 0
fi

# Least privilege. The agent reads untrusted text (public issue/PR bodies, page
# content), so: no permission bypass (dontAsk = unlisted tools are denied, never
# prompted); reads limited to the worktree + RUN_DIR with .env denied; writes
# limited to RUN_DIR; Bash limited to read-only gh queries (no curl/jq/git, no
# --body-file); GitHub writes go through the outbox, validated + published by
# this script. QA_HOME/bin and state.json are out of reach.
ALLOWED_TOOLS=(
  "mcp__playwright" "Skill" "ToolSearch" "TodoWrite"
  "Read(/$QA_WORKTREE/**)" "Read(/$RUN_DIR/**)"
  "Edit(/$RUN_DIR/**)"   # Edit rules cover Write too
  "Bash(gh issue list:*)" "Bash(gh issue view:*)"
  "Bash(gh pr list:*)" "Bash(gh pr view:*)" "Bash(gh pr diff:*)"
)
DENIED_TOOLS=(
  "Read(/$QA_WORKTREE/.env*)" "Read(/$QA_WORKTREE/**/.env*)"
  "Edit(/$RUN_DIR/commits.tsv)" "Edit(/$RUN_DIR/mcp.json)" "Edit(/$RUN_DIR/env-*)"
  "Read(/$RUN_DIR/*.log)" "Read(/$RUN_DIR/transcript.jsonl)" "Read(/$RUN_DIR/claude.err)"
  "mcp__playwright__browser_run_code_unsafe"
  "WebFetch" "WebSearch" "Agent" "Task"
)
CLAUDE_ARGS=(-p "$PROMPT" --permission-mode dontAsk
  --allowedTools "${ALLOWED_TOOLS[@]}" --disallowedTools "${DENIED_TOOLS[@]}"
  --strict-mcp-config --mcp-config "$RUN_DIR/mcp.json" --add-dir "$RUN_DIR"
  --output-format stream-json --verbose)
[ -n "${QA_MODEL:-}" ] && CLAUDE_ARGS+=(--model "$QA_MODEL")

log "claude start (timeout $QA_TIMEOUT)"
gtimeout --kill-after=2m "$QA_TIMEOUT" claude "${CLAUDE_ARGS[@]}" > "$RUN_DIR/transcript.jsonl" 2> "$RUN_DIR/claude.err"
RC=$?
log "claude exit=$RC"

# --- publish the outbox (trusted side) ---------------------------------------
MAX_NEW_ISSUES="${QA_MAX_NEW_ISSUES:-10}"
publish_outbox() {
  gh -R "$QA_REPO" label create qa-sweep --color C5DEF5 --description "Found by the scheduled UI QA sweep" >/dev/null 2>&1 || true
  gh -R "$QA_REPO" label create qa-swept --color 0E8A16 --description "Merged PR checked in the browser by the scheduled UI QA sweep (see QA comment)" >/dev/null 2>&1 || true
  gh -R "$QA_REPO" label create qa-no-ui --color EDEDED --description "Merged PR reviewed by the scheduled QA sweep: no UI surface to test" >/dev/null 2>&1 || true
  local created=0 prs=0 f action title issue labels bodyf pr result
  for f in "$RUN_DIR"/outbox/*.json; do
    [ -f "$f" ] || continue
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
        labels="$(gh -R "$QA_REPO" issue view "$issue" --json labels,state --jq 'select(.state=="OPEN")|[.labels[].name]|join(",")' 2>/dev/null)"
        case ",$labels," in *,qa-sweep,*) gh -R "$QA_REPO" issue comment "$issue" --body-file "$bodyf" ;;
          *) log "outbox REJECT $(basename "$f"): #$issue is not an open qa-sweep issue" ;; esac ;;
      pr_result)
        pr="$(jq -r '.pr // empty' "$f")"; result="$(jq -r '.result // empty' "$f")"
        [[ "$pr" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad pr '$pr'"; continue; }
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
  log "outbox: $created issue(s) created, $prs PR(s) annotated"
  if [ -s "$RUN_DIR/ledger.md" ] && body_ok "$RUN_DIR/ledger.md"; then
    local n; n="$(gh -R "$QA_REPO" issue list --label qa-sweep --state open --search 'QA sweep ledger in:title' --json number,title \
                 --jq '[.[]|select(.title=="QA sweep ledger")][0].number // empty')"
    if [ -n "$n" ]; then gh -R "$QA_REPO" issue edit "$n" --body-file "$RUN_DIR/ledger.md" >/dev/null
    else gh -R "$QA_REPO" issue create --title "QA sweep ledger" --label qa-sweep --body-file "$RUN_DIR/ledger.md" >/dev/null; fi
    log "ledger updated"
  fi
}
publish_outbox

# --- advance cursor only on a completed sweep -------------------------------
if [ "$RC" = 0 ] && [ -f "$RUN_DIR/report.md" ]; then
  tmp="$(mktemp)"
  jq -n --slurpfile old <(cat "$STATE" 2>/dev/null || echo '{}') \
     --arg sha "$NEW_SHA" --arg run "$RUN_ID" --argjson slice "$(( (SLICE + 1) % 4 ))" \
     '($old[0] // {}) + {lastSweptSha:$sha, lastRun:$run, nextSlice:$slice}' > "$tmp" && mv "$tmp" "$STATE"
  ln -sfn "$RUN_DIR" "$QA_HOME/latest"
  SUMMARY="$(grep -m1 -E '^RESULT:' "$RUN_DIR/report.md" | cut -c1-180)"
  notify "${SUMMARY:-Sweep complete} — main@${NEW_SHA:0:9}"
else
  notify "QA sweep did not complete (exit $RC); cursor not advanced. Log: $RUN_DIR"
fi

# keep 30 days of runs
find "$QA_HOME/runs" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null
exit "$RC"
