#!/usr/bin/env bash
# Renders the launchd plist from the environment and loads it.
#   ./install.sh --dry-run   print the plist, write nothing
#   ./install.sh             write ~/Library/LaunchAgents/<label>.plist and bootstrap it
set -euo pipefail

LABEL=com.lanternops.breeze-ci-shepherd
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/$LABEL.plist.template"
HOME_DIR=${BREEZE_CI_SHEPHERD_HOME:-$HOME/.local/share/breeze-ci-shepherd}
RUN_SH="$HOME_DIR/checkout/scripts/ci-shepherd/run.sh"
STATE_DIR=${BREEZE_CI_SHEPHERD_STATE:-$HOME/.local/state/breeze-ci-shepherd}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) echo "usage: install.sh [--dry-run]" >&2; exit 2 ;;
esac

xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}

# Literal replace of every occurrence of a token (no regex, no '&' surprises).
replace_all() { # text token value
  local text=$1 token=$2 value=$3 out=""
  while [[ $text == *"$token"* ]]; do
    out+="${text%%"$token"*}$value"
    text=${text#*"$token"}
  done
  printf '%s' "$out$text"
}

render() {
  local t
  t="$(cat "$TEMPLATE")"
  t="$(replace_all "$t" __RUN_SH__ "$(xml_escape "$RUN_SH")")"
  t="$(replace_all "$t" __HOME__ "$(xml_escape "$HOME")")"
  t="$(replace_all "$t" __USER__ "$(xml_escape "${USER:-$(id -un)}")")"
  t="$(replace_all "$t" __PATH__ "$(xml_escape "$PATH")")"
  printf '%s\n' "$t"
}

if [ "$dry" = 1 ]; then
  render
  exit 0
fi

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents" "$HOME_DIR"
# launchd runs run.sh from the shepherd's own clone, so the clone must exist
# before the first start (run.sh refreshes it on every run after that).
if [ ! -d "$HOME_DIR/checkout/.git" ]; then
  git clone --filter=blob:none https://github.com/LanternOps/breeze.git "$HOME_DIR/checkout"
  git -C "$HOME_DIR/checkout" config credential.helper '!gh auth git-credential'
fi
render > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $PLIST"
