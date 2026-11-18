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

# shellcheck source=sweep-lib.sh
. "$SCRIPT_DIR/sweep-lib.sh"

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
ENVVALS="$QA_HOME/.envvals"   # literal .env values; outside RUN_DIR so the agent can't read it
# Env files with real values (the root .env is a copy of the developer's) are
# parked here while the agent runs: the agent's cwd is the worktree, and a Read
# deny rule does not cover every tool that can read a file. Compose only needs
# them at (re)start, so the running stack is unaffected. Every non-example
# .env* anywhere in the worktree is parked under its relative path.
STACK_ENV_DIR="$QA_HOME/.stack-env"
# list_env_files <dir>: NUL-separated non-example .env* files/symlinks under <dir>.
list_env_files() {
  find "$1" \( -name node_modules -o -name .git \) -prune -o \
    -name '.env*' ! -name '*.example' \( -type f -o -type l \) -print0
}
hide_stack_env() {
  local f rel
  ( umask 077; mkdir -p "$STACK_ENV_DIR" ) && chmod 0700 "$STACK_ENV_DIR" || return 1
  while IFS= read -r -d '' f; do
    rel="${f#"$QA_WORKTREE"/}"
    ( umask 077; mkdir -p "$STACK_ENV_DIR/$(dirname "$rel")" ) || return 1
    mv -f "$f" "$STACK_ENV_DIR/$rel" || return 1
  done < <(list_env_files "$QA_WORKTREE")
  return 0
}
restore_stack_env() {
  local f rel
  [ -d "$STACK_ENV_DIR" ] || return 0
  while IFS= read -r -d '' f; do
    rel="${f#"$STACK_ENV_DIR"/}"
    mkdir -p "$QA_WORKTREE/$(dirname "$rel")" && mv -f "$f" "$QA_WORKTREE/$rel"
  done < <(find "$STACK_ENV_DIR" \( -type f -o -type l \) -print0)
  find "$STACK_ENV_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
  return 0
}
# build_envvals: literal values (>= 8 chars) of every entry in every non-example
# .env* in the worktree -> redaction list for public sinks. .env.stack is left
# out: wt-stack writes dev defaults and the stack's own URL there, which reports
# legitimately quote.
build_envvals() {
  local f files=()
  while IFS= read -r -d '' f; do
    case "${f##*/}" in .env.stack|.env.stack.tmp) continue ;; esac
    files+=("$f")
  done < <(list_env_files "$QA_WORKTREE")
  ( umask 077
    if [ "${#files[@]}" -gt 0 ]; then
      grep -hE '^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' -- "${files[@]}" 2>/dev/null
    fi | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//' \
      | awk 'length($0) >= 8' | sort -u > "$ENVVALS" )
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
  restore_stack_env
  if [ "$STACK_UP" = 1 ]; then
    log "tearing down stack"
    (cd "$QA_WORKTREE" && pnpm wt-stack down) || log "WARN: wt-stack down failed"
  fi
  [ -f "$QA_WORKTREE/.env.pre-hosted" ] && mv "$QA_WORKTREE/.env.pre-hosted" "$QA_WORKTREE/.env"
  remove_stack_net
  stop_egress_proxy; stop_gh_broker
  rm -f "$ENVVALS"; rm -rf "$LOCK"
}
trap cleanup EXIT

log "=== QA sweep $RUN_ID ==="

# --- subscription auth only (never API billing) ------------------------------
# An API key / alt provider in the environment silently overrides the claude.ai
# login, so strip them and then require authMethod=claude.ai.
# QA_CLAUDE_AUTH_DIR pins a specific claude.ai login profile (multi-account setups).
# The agent runs with its own CLAUDE_CONFIG_DIR (agent_claude_dir: the sandbox
# lets it write there and nowhere in ~/.claude), so the login is located through
# CLAUDE_SECURESTORAGE_CONFIG_DIR, pinned here; ~/.claude is the default profile.
export CLAUDE_SECURESTORAGE_CONFIG_DIR="${QA_CLAUDE_AUTH_DIR:-${CLAUDE_SECURESTORAGE_CONFIG_DIR:-$HOME/.claude}}"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
      CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY \
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD   # no CLAUDE.md from the agent-writable RUN_DIR
# Checked with the agent's config dir, so this proves the login the agent will use.
reset_agent_claude_dir || { log "FATAL could not create the agent's claude config dir"; exit 1; }
AUTH_METHOD="$(CLAUDE_CONFIG_DIR="$(agent_claude_dir)" claude auth status --json 2>/dev/null | jq -r '.authMethod // empty')"
if [ "$AUTH_METHOD" != "claude.ai" ]; then
  notify "QA sweep skipped: Claude is not logged in with a subscription for the agent (auth=${AUTH_METHOD:-none}). Set QA_CLAUDE_AUTH_DIR or run: claude auth login"
  log "FATAL auth method '${AUTH_METHOD:-none}', expected claude.ai"; exit 1
fi
log "auth: claude.ai subscription"

# --- docker engine -----------------------------------------------------------
ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  log "docker engine down; starting OrbStack"
  (command -v orb >/dev/null && orb start) || open -ga OrbStack
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 5; done
  return 1
}
ensure_docker || { notify "QA sweep skipped: Docker engine would not start"; log "FATAL docker"; exit 1; }

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
[[ "$QA_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { notify "QA sweep: could not resolve GitHub repo"; log "FATAL bad QA_REPO '$QA_REPO'"; exit 1; }

if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" = "$NEW_SHA" ] && [ "${QA_FORCE:-0}" != 1 ]; then
  log "main unchanged since last sweep; nothing to do"; exit 0
fi

# --- environment: derive from main, detect drift ------------------------------
# The QA stack must run what main says (.env.example, compose, .nvmrc, go.mod),
# not whatever a dev .env happened to pin. Anything that changed since the last
# sweep (e.g. Postgres 16 -> 18) is reported, forces a rebuild, and is filed as
# a [QA] issue so the release's self-hoster upgrade notes can't miss it.
DRIFT="$RUN_DIR/env-drift.md"; : > "$DRIFT"

restore_stack_env   # a run killed while the agent ran leaves them parked
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

# Baseline: hosted-mode keys start OFF every run (the hosted phase sets them
# temporarily); only a deliberate machine-local override can turn them on.
[ -f .env.pre-hosted ] && mv .env.pre-hosted .env
grep -vE '^(IS_HOSTED|BREEZE_AI_AGENTS_ENABLED|BREEZE_WISP_ENABLED)=' .env > .env.tmp && mv .env.tmp .env

# Feature-flag overrides: bundled defaults, then machine-local (local wins).
for ov in "$SCRIPT_DIR/qa-env.overrides" "$QA_HOME/env.overrides"; do
  [ -f "$ov" ] || continue
  while IFS= read -r line; do
    key="${line%%=*}"
    grep -v "^$key=" .env > .env.tmp; printf '%s\n' "$line" >> .env.tmp; mv .env.tmp .env
    log "override $key from $(basename "$ov")"
  done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$ov")
done

build_envvals   # literal env values -> redaction list for public sinks

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
# The engine itself dying mid-build (OrbStack crash, host sleep) is a QA-Mac
# problem, not a main problem: restart it and retry once, and never file a
# "main fails to boot" issue for it.
DOCKER_DIED_RE='failed to connect to the docker API|Cannot connect to the Docker daemon|rpc error: code = Unavailable|docker\.sock: connect'
stack_healthy() { [ -f .breeze-stack.json ] && curl -sf -o /dev/null "$(jq -r .baseUrl .breeze-stack.json 2>/dev/null)/health"; }
engine_failed() { ! docker info >/dev/null 2>&1 || grep -Eq "$DOCKER_DIED_RE" "$RUN_DIR/stack-up.log"; }
for attempt in 1 2; do
  if ! pnpm wt-stack up $REBUILD 2>&1 | tee "$RUN_DIR/stack-up.log"; then :; fi
  stack_healthy && break
  engine_failed || break
  cp "$RUN_DIR/stack-up.log" "$RUN_DIR/stack-up.attempt$attempt.log"
  if [ "$attempt" = 1 ]; then
    log "docker engine failed during stack up; restarting it and retrying once"
    (command -v orb >/dev/null && orb stop) >/dev/null 2>&1 || true
    ensure_docker || break
  fi
done
if ! stack_healthy && engine_failed; then
  notify "QA sweep skipped: Docker engine died during stack boot (QA Mac issue, not main). Retrying next run"
  log "FATAL docker engine failed during stack up; no issue filed"
  echo "DOCKER_ENGINE_FAILED" > "$RUN_DIR/result"; exit 1
fi
if ! stack_healthy; then
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
# The agent may reach exactly this loopback port of the stack (see qa_sandbox_profile).
QA_STACK_PORT="$(printf '%s' "$BASE_URL" | sed -nE 's#^http://(localhost|127\.0\.0\.1)(:([0-9]{1,5}))?(/.*)?$#\3#p')"
case "$BASE_URL" in http://localhost|http://localhost/*|http://127.0.0.1|http://127.0.0.1/*) QA_STACK_PORT=80 ;; esac
[[ "$QA_STACK_PORT" =~ ^[0-9]{1,5}$ ]] || { notify "QA sweep: unexpected stack URL"; log "FATAL stack baseUrl '$BASE_URL' is not a loopback http URL"; exit 1; }

# --- the stack's own egress: internal-only network (see isolate_stack) --------
STACK_PROJECT="$(jq -r .project .breeze-stack.json)"
secure_stack() {
  isolate_stack "$STACK_PROJECT" caddy && stack_isolation_check "$STACK_PROJECT" api caddy || return 1
  local _
  for _ in $(seq 1 24); do curl -sf -o /dev/null "$BASE_URL/health" && return 0; sleep 5; done
  log "stack unhealthy after isolation"; return 1
}
if ! secure_stack; then
  notify "QA sweep: could not cut the QA stack off from the internet; agent not started (see $LOG)"
  log "FATAL stack isolation"; echo "STACK_ISOLATION_FAILED" > "$RUN_DIR/result"; exit 1
fi

# --- the sweep ---------------------------------------------------------------
SLICE="$(state_get .nextSlice)"; SLICE="${SLICE:-0}"
mkdir -p "$RUN_DIR/outbox" "$RUN_DIR/browser"
# RUN_DIR is agent-writable and passed with --add-dir; a read-only, empty
# .claude/ keeps skills/commands/agents/settings from being created there.
mkdir -p "$RUN_DIR/.claude" && chmod 0555 "$RUN_DIR/.claude"

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

# Hosted-only surfaces (Wisp): self-hosted is the default product under test, so
# PRs touching these paths are deferred to a second, hosted-mode phase on the
# SAME stack. PRs whose hosted check failed last time are carried forward.
HOSTED_PATHS_RE="${QA_HOSTED_PATHS_RE:-(^|/)[^/]*wisp[^/]*(/|$)}"
HOSTED_PRS_FILE="$RUN_DIR/hosted-prs.txt"
{
  while IFS=$'\t' read -r sha _ subj; do
    pr="$(printf '%s' "$subj" | sed -nE 's/.*\(#([0-9]+)\)[[:space:]]*$/\1/p')"
    [ -n "$pr" ] || continue
    git show --name-only --format= "$sha" | grep -qiE "$HOSTED_PATHS_RE" && echo "$pr"
  done < "$RUN_DIR/commits.tsv"
  state_get '.pendingHostedPrs // [] | .[]'
} | grep -E '^[0-9]{1,7}$' | sort -un > "$HOSTED_PRS_FILE"
chmod 0444 "$HOSTED_PRS_FILE"
# Trusted copy lives in shell memory; the file is only the agent's read-only view.
HOSTED_PRS="$(tr '\n' ' ' < "$HOSTED_PRS_FILE")"
for pr in $HOSTED_PRS; do case "$IN_SCOPE" in *" $pr "*) ;; *) IN_SCOPE="$IN_SCOPE$pr ";; esac; done
log "hosted-phase PRs: $HOSTED_PRS"

# Per-run browser config (see build_mcp_config). With --ignore-roots the
# server's cwd is its file workspace, so it starts in RUN_DIR/browser, never in
# the worktree; file:// stays blocked (Playwright MCP default). The server is
# installed here, outside the sandbox: no npm runs inside it.
if ! prewarm_mcp "$SCRIPT_DIR/qa-mcp.json"; then
  notify "QA sweep: could not install the pinned Playwright MCP server; agent not started"
  log "FATAL Playwright MCP install"; exit 1
fi
build_mcp_config "$BASE_URL" "$SCRIPT_DIR/qa-mcp.json" "$RUN_DIR/mcp.json" \
  || { notify "QA sweep: could not build the MCP config"; exit 1; }

# --- agent sandbox + egress (fixed before the agent starts) -------------------
# The agent's whole process tree runs under a Seatbelt profile: network limited
# to three loopback ports (stack, egress proxy, gh broker), env files/logs/gh
# config unreadable, worktree and runner inputs read-only. Its own traffic
# leaves the machine only through the egress proxy (Anthropic, :443); it reads
# GitHub only through the gh broker (read-only, pinned to QA_REPO); the stack it
# drives has no egress (secure_stack above). The profile is self-checked here;
# if it doesn't hold, the agent never starts.
AGENT_PROFILE="$QA_HOME/.sandbox/agent.sb"
AGENT_TMP="$QA_HOME/.t"   # the agent's TMPDIR; the only place it may use unix sockets (kept short: 104-byte socket paths)
rm -rf "$AGENT_TMP"
( umask 077; mkdir -p "$QA_HOME/.sandbox" "$STACK_ENV_DIR" "$AGENT_TMP" )
snapshot_commentable_issues   # outbox `comment` targets: open qa-sweep issues as of now
log "commentable qa-sweep issues:${QA_COMMENTABLE:- none}"
snapshot_open_issues   # the agent's dedupe list (its GitHub reader has no search)
log "open issues for dedupe: $(wc -l < "$RUN_DIR/open-issues.tsv" | tr -d ' ')"
if ! { start_egress_proxy && start_gh_broker && qa_sandbox_profile "$AGENT_PROFILE" && sandbox_selfcheck; }; then
  notify "QA sweep: agent sandbox/egress proxy failed its self-check; agent not started (see $LOG)"
  log "FATAL sandbox self-check"; echo "SANDBOX_FAILED" > "$RUN_DIR/result"; exit 1
fi
# Reads under the home directory are an allow-list, so prove the agent's exact
# command line still finds its claude.ai login (the keychain) from inside.
build_agent_cmd claude auth status --json
SB_AUTH="$("${AGENT_CMD[@]}" 2>/dev/null | jq -r '.authMethod // empty' 2>/dev/null)"
if [ "$SB_AUTH" != claude.ai ]; then
  notify "QA sweep: the agent cannot see its claude.ai login inside the sandbox; agent not started (see $LOG)"
  log "FATAL in-sandbox auth method '${SB_AUTH:-none}', expected claude.ai"; echo "SANDBOX_FAILED" > "$RUN_DIR/result"; exit 1
fi
log "in-sandbox auth: claude.ai subscription"

PROMPT="Read $QA_WORKTREE/.claude/skills/ui-qa-sweep/SKILL.md and follow its **Scheduled mode** section exactly (skills and slash commands are disabled in this run; do not try to invoke them).
Run parameters:
- RUN_DIR=$RUN_DIR   (write report.md, ledger.md and outbox/*.json here — nowhere else)
- BASE_URL=$BASE_URL (stack descriptor: $QA_WORKTREE/.breeze-stack.json)
- MAIN_SHA=$NEW_SHA
- PREV_SWEPT_SHA=${PREV_SHA:-none}
- COMMITS_FILE=$RUN_DIR/commits.tsv (first-parent commits in scope: sha, date, subject)
- ROTATION_SLICE=$SLICE
- ENV_DRIFT_FILE=$DRIFT (environment changes detected this run; empty = none)
- PHASE=self-hosted
- HOSTED_PRS_FILE=$HOSTED_PRS_FILE (PRs deferred to the hosted phase — do NOT emit pr_result for these; empty = none)
- OPEN_ISSUES_FILE=$RUN_DIR/open-issues.tsv (every open issue at run start: number<TAB>title; grep it to dedupe)
- QA_GH=$SCRIPT_DIR/qa-gh (your only GitHub reader: run it exactly where the skill says \`gh\`, e.g. \`$SCRIPT_DIR/qa-gh issue list --label qa-sweep --state open\`; it is fixed to $QA_REPO and has no search)
You are unattended: never ask questions. You cannot write to GitHub directly; queue writes in RUN_DIR/outbox as the skill describes."

# Flip the running stack to hosted mode in place (same DB, same data, same
# origin): hosted env on api/web/portal + a manual `wisp` entitlement for every
# seeded partner. Local dev stack only; never touches a real deployment.
switch_to_hosted() {
  local project pg pguser pgdb
  project="$(jq -r .project .breeze-stack.json)"; pg="$(jq -r .pgContainer .breeze-stack.json)"
  cp .env .env.pre-hosted   # restored by cleanup: hosted mode must never leak into the next run
  for kv in IS_HOSTED=true BREEZE_AI_AGENTS_ENABLED=true BREEZE_WISP_ENABLED=true; do
    grep -v "^${kv%%=*}=" .env > .env.tmp; echo "$kv" >> .env.tmp; mv .env.tmp .env
    # .env.stack (wt-stack, loaded after .env) pins IS_HOSTED=false and would win;
    # it's regenerated on every `wt-stack up`, so editing it can't leak.
    if grep -q "^${kv%%=*}=" .env.stack 2>/dev/null; then
      grep -v "^${kv%%=*}=" .env.stack > .env.stack.tmp; echo "$kv" >> .env.stack.tmp; mv .env.stack.tmp .env.stack
    fi
  done
  log "switching stack to hosted mode"
  docker compose -p "$project" --env-file .env --env-file .env.stack -f docker-compose.yml \
    -f docker-compose.override.yml.dev -f docker-compose.override.yml.worktree \
    up -d --no-deps --force-recreate api web portal >/dev/null 2>&1 || return 1
  for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE_URL/health" && break; sleep 5; done
  curl -sf -o /dev/null "$BASE_URL/health" || return 1
  pguser="$(grep -m1 '^POSTGRES_USER=' .env | cut -d= -f2-)"; pgdb="$(grep -m1 '^POSTGRES_DB=' .env | cut -d= -f2-)"
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -U "${pguser:-breeze}" -d "${pgdb:-breeze}" -qc \
    "INSERT INTO partner_entitlements (partner_id, feature_key, state, source, reason)
       SELECT id, 'wisp', 'enabled', 'manual', 'scheduled QA hosted phase' FROM partners
     ON CONFLICT (partner_id, feature_key, source) DO UPDATE SET state='enabled', revoked_at=NULL" >/dev/null || return 1
  # Prove it took. The API's wispEnabled() is env-only (IS_HOSTED && AI agents &&
  # Wisp), and the routes additionally need the entitlement — check both at the
  # source (API login needs a browser auth-binding round trip, so not via HTTP).
  local apic envs ent
  apic="$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=api" --format '{{.Names}}' | head -1)"
  envs="$(docker exec "$apic" sh -c 'echo "$IS_HOSTED $BREEZE_AI_AGENTS_ENABLED $BREEZE_WISP_ENABLED"' 2>/dev/null)"
  ent="$(docker exec "$pg" psql -U "${pguser:-breeze}" -d "${pgdb:-breeze}" -tAc \
        "select count(*) from partner_entitlements where feature_key='wisp' and state='enabled' and revoked_at is null" 2>/dev/null)"
  log "hosted mode up (api env: ${envs:-?}; wisp entitlements: ${ent:-?})"
  [ "$envs" = "true true true" ] && [ "${ent:-0}" -ge 1 ] 2>/dev/null \
    || { log "WARN: hosted switch did not take (expected 'true true true' and >=1 entitlement)"; return 1; }
}

if [ "${QA_DRY_RUN:-0}" = 1 ]; then
  log "DRY RUN: skipping claude (sandbox self-check passed above). prompt was:"; echo "$PROMPT"; cat "$RUN_DIR/mcp.json" "$AGENT_PROFILE"
  curl -sf -o /dev/null "$BASE_URL/health" && log "health OK" || log "health FAILED"
  for u in "$BASE_URL/api/v1/config" "$BASE_URL/api/config"; do
    f="$(curl -sf "$u" 2>/dev/null | jq -c '.features // empty' 2>/dev/null)" && [ -n "$f" ] && { log "features: $f"; break; }
  done
  if [ -n "${HOSTED_PRS// /}" ] || [ "${QA_DRY_HOSTED:-0}" = 1 ]; then
    switch_to_hosted && secure_stack && log "DRY RUN: hosted switch OK" || log "DRY RUN: hosted switch FAILED"
  fi
  exit 0
fi

# Least privilege. The agent reads untrusted text (public issue/PR bodies, page
# content), so: no permission bypass (dontAsk = unlisted tools are denied, never
# prompted); reads limited to the worktree + RUN_DIR; writes limited to RUN_DIR;
# Bash limited to qa-gh, the gh broker's client (read-only issue/PR queries,
# repo fixed by the broker; no curl/jq/git, no gh itself); GitHub writes go
# through the outbox, validated + published by this script.
# QA_HOME/bin and state.json are out of reach. The stack's .env files are moved
# out of the worktree for the duration of each run (hide_stack_env).
# Skills and slash commands are off (Skill denied, --disable-slash-commands,
# disableSkillShellExecution): the agent reads SKILL.md as a plain file.
# Browser: an explicit list of navigation/snapshot/interaction tools. No page
# JavaScript (browser_evaluate, browser_run_code_unsafe), no request routing,
# no local file upload/drop.
# These permission rules are the first layer only. The enforcement layer the
# agent cannot step around is the Seatbelt sandbox + egress proxy set up above
# (qa_sandbox_profile/start_egress_proxy in sweep-lib.sh): it binds every tool,
# every Bash command and the browser, not just the tools these rules name.
PW_TOOLS=(
  browser_navigate browser_navigate_back browser_tabs browser_close browser_resize
  browser_snapshot browser_find browser_take_screenshot browser_wait_for
  browser_click browser_hover browser_drag browser_type browser_press_key
  browser_fill_form browser_select_option browser_handle_dialog browser_emulate_media
  browser_console_messages browser_network_requests browser_network_request
)
ALLOWED_TOOLS=(
  "${PW_TOOLS[@]/#/mcp__playwright__}" "ToolSearch" "TodoWrite"
  "Read(/$QA_WORKTREE/**)" "Read(/$RUN_DIR/**)"
  "Edit(/$RUN_DIR/**)"   # Edit rules cover Write too
  # GitHub reads only through the broker's client. The rule is the first layer;
  # the boundary is the broker (repo pinned, read-only verbs) plus the sandbox
  # (no route to GitHub, gh config unreadable), so gh itself cannot work inside.
  "Bash($SCRIPT_DIR/qa-gh:*)"
)
DENIED_TOOLS=(
  "Skill"
  "Read(/$QA_WORKTREE/.env*)" "Read(/$QA_WORKTREE/**/.env*)"
  "Edit(/$RUN_DIR/commits.tsv)" "Edit(/$RUN_DIR/open-issues.tsv)" "Edit(/$RUN_DIR/hosted-prs.txt)" "Edit(/$RUN_DIR/mcp.json)" "Edit(/$RUN_DIR/env-*)"
  "Edit(/$RUN_DIR/.claude/**)" "Edit(/$RUN_DIR/**/.claude/**)"
  "Edit(/$RUN_DIR/CLAUDE.md)" "Edit(/$RUN_DIR/**/CLAUDE.md)" "Edit(/$RUN_DIR/**/CLAUDE.local.md)"
  "Edit(/$RUN_DIR/*.log)" "Edit(/$RUN_DIR/*.err)" "Edit(/$RUN_DIR/transcript*)"
  "Read(/$RUN_DIR/*.log)" "Read(/$RUN_DIR/transcript*.jsonl)" "Read(/$RUN_DIR/claude*.err)"
  "mcp__playwright__browser_evaluate" "mcp__playwright__browser_run_code_unsafe"
  "mcp__playwright__browser_route" "mcp__playwright__browser_unroute"
  "mcp__playwright__browser_route_list" "mcp__playwright__browser_network_state_set"
  "mcp__playwright__browser_file_upload" "mcp__playwright__browser_drop"
  # Built-in read-only shell commands can run without an allow rule, and a Read
  # deny rule doesn't bind a command that reads without naming the file
  # (`grep -r x .`). Bash is here only for gh, so deny the readers outright.
  "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(less:*)" "Bash(more:*)"
  "Bash(grep:*)" "Bash(egrep:*)" "Bash(fgrep:*)" "Bash(rg:*)" "Bash(ag:*)"
  "Bash(find:*)" "Bash(xargs:*)" "Bash(sed:*)" "Bash(awk:*)" "Bash(cut:*)"
  "Bash(sort:*)" "Bash(uniq:*)" "Bash(diff:*)" "Bash(cmp:*)" "Bash(comm:*)"
  "Bash(strings:*)" "Bash(xxd:*)" "Bash(od:*)" "Bash(hexdump:*)" "Bash(base64:*)"
  "Bash(nl:*)" "Bash(tac:*)" "Bash(rev:*)" "Bash(wc:*)" "Bash(jq:*)" "Bash(git:*)"
  "Bash(gh:*)" "Bash(curl:*)" "Bash(python3:*)" "Bash(/usr/bin/python3:*)"
  "WebFetch" "WebSearch" "Agent" "Task"
)
run_agent() {  # run_agent <prompt> <timeout> <transcript-suffix>
  local args=(-p "$1" --permission-mode dontAsk
    --allowedTools "${ALLOWED_TOOLS[@]}" --disallowedTools "${DENIED_TOOLS[@]}"
    --disable-slash-commands --settings '{"disableSkillShellExecution":true,"sandbox":{"enabled":false}}'
    --strict-mcp-config --mcp-config "$RUN_DIR/mcp.json" --add-dir "$RUN_DIR"
    --output-format stream-json --verbose)
  [ -n "${QA_MODEL:-}" ] && args+=(--model "$QA_MODEL")
  if ! hide_stack_env; then
    restore_stack_env; log "FATAL could not move the stack env files out of the worktree; agent not started"
    return 1
  fi
  # A fresh config dir per agent run: nothing one run writes there (settings,
  # hooks, memory) reaches the next one, e.g. the hosted phase.
  if ! reset_agent_claude_dir; then
    restore_stack_env; log "FATAL could not reset the agent's claude config dir; agent not started"
    return 1
  fi
  # The transcript and stderr are runner files in the agent's RUN_DIR. The
  # sandbox forbids the agent those names; the runner also creates them only
  # where nothing exists yet (no symlink followed) and never clobbers.
  local tr="$RUN_DIR/transcript$3.jsonl" er="$RUN_DIR/claude$3.err"
  if ! runner_fresh_path "$tr" || ! runner_fresh_path "$er"; then
    restore_stack_env; log "FATAL $tr or $er already exists; agent not started"
    return 1
  fi
  log "claude start [$3] (timeout $2)"
  build_agent_cmd claude "${args[@]}"   # sandbox-exec + proxy env around claude
  ( set -C; exec gtimeout --kill-after=2m "$2" "${AGENT_CMD[@]}" > "$tr" 2> "$er" )
  local rc=$?; restore_stack_env; log "claude exit [$3]=$rc"; return $rc
}

run_agent "$PROMPT" "$QA_TIMEOUT" ""
RC=$?

# --- hosted phase (only when hosted-only surfaces were touched) ---------------
HOSTED_OK=1; HOSTED_NOTE=""
# From here on RUN_DIR is the agent's: the runner reads it only through
# _agent_io and writes nothing into it (see sweep-lib.sh).
if [ "$RC" = 0 ] && [ -n "${HOSTED_PRS// /}" ]; then
  HOSTED_OK=0
  if switch_to_hosted && secure_stack; then   # the recreated containers start on the project network again
    HPROMPT="Read $QA_WORKTREE/.claude/skills/ui-qa-sweep/SKILL.md and follow its **Scheduled mode** section, **Hosted phase** subsection, exactly (skills and slash commands are disabled in this run; do not try to invoke them).
Run parameters:
- RUN_DIR=$RUN_DIR   (append to report.md; update ledger.md; add outbox/*.json — nowhere else)
- BASE_URL=$BASE_URL (same stack and data as the self-hosted phase, now IS_HOSTED=true with Wisp enabled + entitled)
- MAIN_SHA=$NEW_SHA
- PHASE=hosted
- HOSTED_PRS_FILE=$HOSTED_PRS_FILE (verify exactly these PRs; emit one pr_result each)
- COMMITS_FILE=$RUN_DIR/commits.tsv
- OPEN_ISSUES_FILE=$RUN_DIR/open-issues.tsv (every open issue at run start: number<TAB>title; grep it to dedupe)
- QA_GH=$SCRIPT_DIR/qa-gh (your only GitHub reader, fixed to $QA_REPO, no search; use it where the skill says \`gh\`)
You are unattended: never ask questions. Queue GitHub writes in RUN_DIR/outbox as the skill describes."
    run_agent "$HPROMPT" "${QA_HOSTED_TIMEOUT:-90m}" "-hosted" && HOSTED_OK=1
  else
    log "hosted switch FAILED; hosted PRs carried to next run"
    HOSTED_NOTE=" (hosted phase skipped: could not switch the stack to hosted mode)"
  fi
fi

# --- publish the outbox (trusted side) ---------------------------------------
# shellcheck disable=SC2034  # read by publish_outbox (sweep-lib.sh)
MAX_NEW_ISSUES="${QA_MAX_NEW_ISSUES:-10}"
publish_outbox

# Hosted PRs carry to the next run unless they got a conclusive verdict here.
# BLOCKED (e.g. no LLM key on the stack) or a missing/rejected verdict is not
# conclusive. Each PR gets QA_HOSTED_MAX_TRIES runs before it is dropped.
PENDING_HOSTED=""
for pr in $HOSTED_PRS; do
  verdict=""
  # The verdict publish_outbox validated and published (runner memory, never
  # agent files re-read here).
  [ "$HOSTED_OK" = 1 ] && verdict="$(hosted_verdict "$pr")"
  case "$verdict" in PASS|PARTIAL|FAIL|NO_UI) ;; *) PENDING_HOSTED="$PENDING_HOSTED $pr" ;; esac
done
[ -n "${PENDING_HOSTED// /}" ] && log "hosted PRs carried to next run:$PENDING_HOSTED"

# --- advance cursor only on a completed sweep -------------------------------
if [ "$RC" = 0 ] && agent_report_present; then
  tmp="$(mktemp)"
  jq -n --slurpfile old <(cat "$STATE" 2>/dev/null || echo '{}') \
     --arg sha "$NEW_SHA" --arg run "$RUN_ID" --argjson slice "$(( (SLICE + 1) % 4 ))" \
     --argjson pend "$(printf '%s\n' $PENDING_HOSTED | jq -R 'select(length>0)' | jq -s .)" \
     --argjson maxtries "${QA_HOSTED_MAX_TRIES:-7}" \
     '($old[0] // {}) as $o
      | ($o.pendingHostedTries // {}) as $t
      | ([$pend[] | {key: ., value: (($t[.] // 0) + 1)}] | from_entries) as $nt
      | ($nt | to_entries | map(select(.value < $maxtries)) | from_entries) as $kt
      | $o + {lastSweptSha:$sha, lastRun:$run, nextSlice:$slice,
              pendingHostedPrs: [$pend[] | select($kt[.] != null)], pendingHostedTries: $kt}' > "$tmp" && mv "$tmp" "$STATE"
  ln -sfn "$RUN_DIR" "$QA_HOME/latest"
  SUMMARY="$(agent_report_summary)"
  notify "${SUMMARY:-Sweep complete} — main@${NEW_SHA:0:9}$HOSTED_NOTE"
else
  notify "QA sweep did not complete (exit $RC); cursor not advanced$HOSTED_NOTE. Log: $RUN_DIR"
fi

# keep 30 days of runs and their egress audit logs
find "$QA_HOME/runs" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null
find "$QA_HOME/.audit" -type f -name 'egress-*.log' -mtime +30 -delete 2>/dev/null
exit "$RC"
