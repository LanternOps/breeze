#!/usr/bin/env bash
# One CI shepherd run, started by launchd every five minutes (W06b, #10750).
# It works only in its own clone and appends exactly one line to runs.log.
set -euo pipefail

HOME_DIR=${BREEZE_CI_SHEPHERD_HOME:-$HOME/.local/share/breeze-ci-shepherd}
STATE_DIR=${BREEZE_CI_SHEPHERD_STATE:-$HOME/.local/state/breeze-ci-shepherd}
mkdir -p "$STATE_DIR" "$HOME_DIR"

# Each step fails the run on its own: `set -e` is off inside the `if` below,
# and a failed fetch must not leave the tick running yesterday's code.
prepare() {
  if [ ! -d "$HOME_DIR/checkout/.git" ]; then
    git clone --filter=blob:none https://github.com/LanternOps/breeze.git "$HOME_DIR/checkout" || { echo "ci-shepherd run: clone failed"; return 1; }
    git -C "$HOME_DIR/checkout" config credential.helper '!gh auth git-credential' || { echo "ci-shepherd run: credential config failed"; return 1; }
  fi
  git -C "$HOME_DIR/checkout" fetch --quiet origin main || { echo "ci-shepherd run: fetch of main failed"; return 1; }
  git -C "$HOME_DIR/checkout" checkout --quiet --detach FETCH_HEAD || { echo "ci-shepherd run: checkout failed"; return 1; }
  GH_TOKEN="$(gh auth token)" || { echo "ci-shepherd run: gh auth token failed"; return 1; }
  [ -n "$GH_TOKEN" ] || { echo "ci-shepherd run: gh auth token is empty"; return 1; }
  export GH_TOKEN
}

run_tick() {
  node "$HOME_DIR/checkout/scripts/ci-shepherd/shepherd.mjs" tick --repo LanternOps/breeze --state-dir "$STATE_DIR"
}

# set -e is suspended inside the `if`, so a failure still reaches the log line.
if out="$( { prepare && run_tick; } 2>&1 )"; then
  code=0
else
  code=$?
fi

summary="$(printf '%s\n' "$out" | tail -n 1 | tr '\r\n\t' '   ')"
printf '%s exit=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$summary" >> "$STATE_DIR/runs.log"
printf '%s\n' "$out"
exit "$code"
