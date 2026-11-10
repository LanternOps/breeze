#!/usr/bin/env bash
# One CI shepherd run, started by launchd every five minutes (W06b, #10750).
# It works only in its own clone and appends exactly one line to runs.log.
set -euo pipefail

HOME_DIR=${BREEZE_CI_SHEPHERD_HOME:-$HOME/.local/share/breeze-ci-shepherd}
STATE_DIR=${BREEZE_CI_SHEPHERD_STATE:-$HOME/.local/state/breeze-ci-shepherd}
mkdir -p "$STATE_DIR" "$HOME_DIR"

prepare() {
  if [ ! -d "$HOME_DIR/checkout/.git" ]; then
    git clone --filter=blob:none https://github.com/LanternOps/breeze.git "$HOME_DIR/checkout"
    git -C "$HOME_DIR/checkout" config credential.helper '!gh auth git-credential'
  fi
  git -C "$HOME_DIR/checkout" fetch --quiet origin main
  git -C "$HOME_DIR/checkout" checkout --quiet --detach FETCH_HEAD
  GH_TOKEN="$(gh auth token)"
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
