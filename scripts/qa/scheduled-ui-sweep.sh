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
#   QA_AGENT_TOKEN_FILE the agent's own `claude setup-token` token (default $QA_HOME/.agent-auth/oauth-token)
#   QA_MAX_NEW_ISSUES  cap on issues filed per run       (default 10)
#   QA_REPO            the ONLY repo the sweep writes to (default LanternOps/breeze-qa).
#                      Must be private: checked before any other GitHub call and
#                      again before publishing; anything else and nothing is published.
#   QA_CODE_REPO       the code repo (default: the source repo's origin). Never a target.
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
# runner_issue (sweep-lib.sh) files the runner's own findings into QA_REPO.

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
  stop_model_forwarder; stop_egress_proxy
  rm -f "$ENVVALS" "$ENVVALS".*; rm -rf "$LOCK"   # .* = a killed build's temp files
}
trap cleanup EXIT

log "=== QA sweep $RUN_ID ==="

# --- subscription auth only (never API billing) ------------------------------
# The agent's model calls carry its own long-lived claude.ai token (`claude
# setup-token`, stored by install-schedule.sh --agent-token; agent_token_path),
# never the developer's login: the sandbox gives it no keychain at all. The
# agent itself never holds the token (Strix r10): the runner pipes it to the
# model forwarder (start_model_forwarder), which adds it to the agent's
# requests outside the sandbox. An API key / alt provider in the environment
# would change how claude authenticates, so strip them here, and the agent's
# command strips them again (build_agent_cmd).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
      CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY \
      CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR \
      CLAUDE_SECURESTORAGE_CONFIG_DIR \
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD   # no CLAUDE.md from the agent-writable RUN_DIR
reset_agent_claude_dir || { log "FATAL could not create the agent's claude config dir"; exit 1; }
if ! load_agent_token; then
  notify "QA sweep skipped: no agent token. Run: claude setup-token, then scripts/qa/install-schedule.sh --agent-token"
  log "FATAL no usable agent token at $(agent_token_path)"; exit 1
fi
log "auth: agent's own claude.ai token loaded (held by the model forwarder only; proven against the API by the sandbox self-check)"

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
# Output is private (2026-11-19): the sweep writes only to QA_REPO, which must be
# a private repo and not the code repo; nothing is posted to the public PRs.
# Checked here, before any other GitHub call, and again before publishing.
QA_REPO="${QA_REPO:-LanternOps/breeze-qa}"
QA_CODE_REPO="${QA_CODE_REPO:-$(repo_slug "$(git -C "$QA_SOURCE_REPO" remote get-url origin 2>/dev/null)")}"
require_private_qa_repo || { notify "QA sweep: $QA_REPO is not a verified private repo; nothing run"; log "FATAL publishing repo '$QA_REPO' not verified private (code repo '${QA_CODE_REPO:-unknown}')"; exit 1; }
log "publishing to $QA_REPO (private; code repo $QA_CODE_REPO is never written)"

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

# The known-value list for published text (sweep-lib.sh). This first build covers
# the boot-failure path; it is rebuilt from the running stack before the agent starts.
build_envvals || { notify "QA sweep: could not build the secret list"; log "FATAL build_envvals"; exit 1; }

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
      # Published excerpt: only error-signature lines, literal .env values stripped,
      # anything still secret-shaped dropped. Full logs stay on the QA Mac.
      echo; echo "### \`$c\` error lines"; echo '```'
      grep -E 'CRITICAL|FATAL|Error:|error:|ERROR' "$RUN_DIR/container-$c.log" | tail -8 | cut -c1-240 \
        | { if [ -s "$ENVVALS" ]; then grep -viF -f "$ENVVALS"; else cat; fi; } \
        | grep -Ev "$SECRET_RE" | grep -Ev "[A-Za-z0-9+/=_-]{48,}|$URL_CREDS_ERE"
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

# Every secret the agent could meet now exists: .env.stack, the descriptor and
# the containers' real environment. No list, no agent.
if ! build_envvals "$STACK_PROJECT"; then
  notify "QA sweep: could not build the secret list from the stack; agent not started"
  log "FATAL build_envvals $STACK_PROJECT"; echo "SECRET_LIST_FAILED" > "$RUN_DIR/result"; exit 1
fi

# --- the sweep ---------------------------------------------------------------
SLICE="$(state_get .nextSlice)"; SLICE="${SLICE:-0}"
mkdir -p "$RUN_DIR/outbox" "$RUN_DIR/browser"
# RUN_DIR is agent-writable and passed with --add-dir; a read-only, empty
# .claude/ keeps skills/commands/agents/settings from being created there.
mkdir -p "$RUN_DIR/.claude" && chmod 0555 "$RUN_DIR/.claude"

# PR scope is computed here (trusted) from local git, so the agent needs no git
# or GitHub access and reads no PR text: commits.tsv = sha, date, PR number;
# changed-files.tsv = sha, path. No subject (= the PR title) or body reaches it.
# IN_SCOPE (the PRs a verdict may name) is shell memory, fixed before the agent runs.
SCOPE_FROM=""
if [ -n "$PREV_SHA" ] && git cat-file -e "$PREV_SHA" 2>/dev/null; then SCOPE_FROM="$PREV_SHA"; fi
compute_scope "$SCOPE_FROM" "$NEW_SHA"
log "commits in scope: $(wc -l < "$RUN_DIR/commits.tsv" | tr -d ' '); PRs:$IN_SCOPE"

# Hosted-only surfaces (Wisp): self-hosted is the default product under test, so
# PRs touching these paths are deferred to a second, hosted-mode phase on the
# SAME stack. PRs whose hosted check failed last time are carried forward.
HOSTED_PATHS_RE="${QA_HOSTED_PATHS_RE:-(^|/)[^/]*wisp[^/]*(/|$)}"
HOSTED_PRS_FILE="$RUN_DIR/hosted-prs.txt"
{
  while IFS=$'\t' read -r sha _ pr; do
    [[ "$pr" =~ ^[0-9]{1,7}$ ]] || continue
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
# to two loopback ports (stack, model forwarder), env files/logs/gh config
# unreadable, worktree and runner inputs read-only. It holds no credential: its
# model calls go to the forwarder, which adds the token and leaves the machine
# through the egress proxy (api.anthropic.com:443 only). It does not read
# GitHub at all: the runner hands it the scope files above and the open
# qa-sweep issues of the private QA repo. The stack it drives has no egress
# (secure_stack above). The profile is self-checked here; if it doesn't hold,
# the agent never starts.
AGENT_PROFILE="$QA_HOME/.sandbox/agent.sb"
AGENT_TMP="$QA_HOME/.t"   # the agent's TMPDIR; the only place it may use unix sockets (kept short: 104-byte socket paths)
rm -rf "$AGENT_TMP"
( umask 077; mkdir -p "$QA_HOME/.sandbox" "$STACK_ENV_DIR" "$AGENT_TMP" )
snapshot_commentable_issues   # outbox `comment` targets: open qa-sweep issues as of now
log "commentable qa-sweep issues:${QA_COMMENTABLE:- none}"
snapshot_open_issues   # the agent's dedupe list: number + title of open qa-sweep issues in QA_REPO
log "open issues for dedupe: $(wc -l < "$RUN_DIR/open-issues.tsv" | tr -d ' ')"
if ! { start_egress_proxy && start_model_forwarder && qa_sandbox_profile "$AGENT_PROFILE" && sandbox_selfcheck; }; then
  notify "QA sweep: agent sandbox/egress proxy/model forwarder failed its self-check; agent not started (see $LOG)"
  log "FATAL sandbox self-check"; echo "SANDBOX_FAILED" > "$RUN_DIR/result"; exit 1
fi
# Prove the agent's exact command line runs in subscription mode on the
# first-party API from inside: the forwarder's placeholder, never an API key.
build_agent_cmd claude auth status --json
SB_AUTH="$("${AGENT_CMD[@]}" 2>/dev/null | jq -r '"\(.authMethod // "none") \(.apiProvider // "none")"' 2>/dev/null)"
if [ "$SB_AUTH" != "oauth_token firstParty" ]; then
  notify "QA sweep: the agent cannot sign in inside the sandbox; agent not started (see $LOG)"
  log "FATAL in-sandbox auth '${SB_AUTH:-none}', expected 'oauth_token firstParty'"; echo "SANDBOX_FAILED" > "$RUN_DIR/result"; exit 1
fi
log "in-sandbox auth: subscription mode via the model forwarder (the agent holds no credential)"

PROMPT="Read $QA_WORKTREE/.claude/skills/ui-qa-sweep/SKILL.md and follow its **Scheduled mode** section exactly (skills and slash commands are disabled in this run; do not try to invoke them).
Run parameters:
- RUN_DIR=$RUN_DIR   (write report.md and outbox/*.json here — nowhere else)
- BASE_URL=$BASE_URL (stack descriptor: $QA_WORKTREE/.breeze-stack.json)
- MAIN_SHA=$NEW_SHA
- PREV_SWEPT_SHA=${PREV_SHA:-none}
- COMMITS_FILE=$RUN_DIR/commits.tsv (first-parent commits in scope: sha<TAB>date<TAB>PR number, '-' = none)
- CHANGED_FILES_FILE=$RUN_DIR/changed-files.tsv (paths each in-scope commit changed: sha<TAB>path)
- ROTATION_SLICE=$SLICE
- ENV_DRIFT_FILE=$DRIFT (environment changes detected this run; empty = none)
- PHASE=self-hosted
- HOSTED_PRS_FILE=$HOSTED_PRS_FILE (PRs deferred to the hosted phase — do NOT emit pr_result for these; empty = none)
- OPEN_ISSUES_FILE=$RUN_DIR/open-issues.tsv (open qa-sweep issues in the private QA repo at run start: number<TAB>title; grep it to dedupe)
You are unattended: never ask questions. You have no GitHub access and no shell; queue writes in RUN_DIR/outbox as the skill describes."

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

# Least privilege. The agent reads no GitHub text at all (2026-11-19 redesign),
# but page content and merged code are still input, so: no permission bypass
# (dontAsk = unlisted tools are denied, never prompted); reads limited to the
# worktree + RUN_DIR; writes limited to RUN_DIR; no Bash at all; GitHub writes
# go through the outbox, validated + published to the private QA repo by this
# script.
# QA_HOME/bin and state.json are out of reach. The stack's .env files are moved
# out of the worktree for the duration of each run (hide_stack_env).
# Skills and slash commands are off (Skill denied, --disable-slash-commands,
# disableSkillShellExecution): the agent reads SKILL.md as a plain file.
# Browser: an explicit list of navigation/snapshot/interaction tools. No page
# JavaScript (browser_evaluate, browser_run_code_unsafe), no request routing,
# no local file upload/drop.
# These permission rules are the first layer only. The enforcement layer the
# agent cannot step around is the Seatbelt sandbox + model forwarder set up above
# (qa_sandbox_profile/start_model_forwarder in sweep-lib.sh): it binds every tool,
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
)
DENIED_TOOLS=(
  "Skill"
  # No shell. Every input the agent needs is a file the runner wrote; a Read
  # deny rule would not bind a shell command that reads without naming the file.
  "Bash"
  "Read(/$QA_WORKTREE/.env*)" "Read(/$QA_WORKTREE/**/.env*)"
  "Edit(/$RUN_DIR/commits.tsv)" "Edit(/$RUN_DIR/changed-files.tsv)" "Edit(/$RUN_DIR/open-issues.tsv)" "Edit(/$RUN_DIR/hosted-prs.txt)" "Edit(/$RUN_DIR/mcp.json)" "Edit(/$RUN_DIR/env-*)"
  "Edit(/$RUN_DIR/.claude/**)" "Edit(/$RUN_DIR/**/.claude/**)"
  "Edit(/$RUN_DIR/CLAUDE.md)" "Edit(/$RUN_DIR/**/CLAUDE.md)" "Edit(/$RUN_DIR/**/CLAUDE.local.md)"
  "Edit(/$RUN_DIR/*.log)" "Edit(/$RUN_DIR/*.err)" "Edit(/$RUN_DIR/transcript*)"
  "Read(/$RUN_DIR/*.log)" "Read(/$RUN_DIR/transcript*.jsonl)" "Read(/$RUN_DIR/claude*.err)"
  "mcp__playwright__browser_evaluate" "mcp__playwright__browser_run_code_unsafe"
  "mcp__playwright__browser_route" "mcp__playwright__browser_unroute"
  "mcp__playwright__browser_route_list" "mcp__playwright__browser_network_state_set"
  "mcp__playwright__browser_file_upload" "mcp__playwright__browser_drop"
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
  build_agent_cmd claude "${args[@]}"   # sandbox-exec + forwarder env around claude
  ( set -C; gtimeout --kill-after=2m "$2" "${AGENT_CMD[@]}" > "$tr" 2> "$er" )
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
  if switch_to_hosted && secure_stack && build_envvals "$STACK_PROJECT"; then   # the recreated containers start on the project network again
    HPROMPT="Read $QA_WORKTREE/.claude/skills/ui-qa-sweep/SKILL.md and follow its **Scheduled mode** section, **Hosted phase** subsection, exactly (skills and slash commands are disabled in this run; do not try to invoke them).
Run parameters:
- RUN_DIR=$RUN_DIR   (append to report.md; add outbox/*.json — nowhere else)
- BASE_URL=$BASE_URL (same stack and data as the self-hosted phase, now IS_HOSTED=true with Wisp enabled + entitled)
- MAIN_SHA=$NEW_SHA
- PHASE=hosted
- HOSTED_PRS_FILE=$HOSTED_PRS_FILE (verify exactly these PRs; emit one pr_result each)
- COMMITS_FILE=$RUN_DIR/commits.tsv
- CHANGED_FILES_FILE=$RUN_DIR/changed-files.tsv
- OPEN_ISSUES_FILE=$RUN_DIR/open-issues.tsv (open qa-sweep issues in the private QA repo at run start: number<TAB>title; grep it to dedupe)
You are unattended: never ask questions. You have no GitHub access and no shell; queue writes in RUN_DIR/outbox as the skill describes."
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
  record_run_ledger "$SUMMARY" 1 || log "WARN: ledger not updated"
  notify "${SUMMARY:-Sweep complete} — main@${NEW_SHA:0:9}$HOSTED_NOTE"
else
  record_run_ledger "" 0 || log "WARN: ledger not updated"
  notify "QA sweep did not complete (exit $RC); cursor not advanced$HOSTED_NOTE. Log: $RUN_DIR"
fi

# keep 30 days of runs and their audit logs
find "$QA_HOME/runs" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null
find "$QA_HOME/.audit" -type f \( -name 'egress-*.log' -o -name 'model-*.log' -o -name 'gh-*.log' \) -mtime +30 -delete 2>/dev/null
exit "$RC"
