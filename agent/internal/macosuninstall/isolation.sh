# Network-isolation teardown (#10099). Embedded in Go for the agent's own
# uninstall paths. Sourced after functions.sh, whose breeze_bootout it uses.
# BEGIN BREEZE MACOS ISOLATION FUNCTIONS
# breeze_release_isolation confirms that no Breeze-owned pf rules remain, and
# must succeed before any Breeze daemon stops: once the agent and the recovery
# jobs are gone, nothing would ever release them. No journal means this Mac
# never held an episode, and an agent that predates containment has no
# release-all to run, so there is nothing to do.
breeze_release_isolation() {
  _breeze_data="/Library/Application Support/Breeze/data"
  if [ ! -e "$_breeze_data/isolation.json" ]; then
    return 0
  fi
  for _breeze_bin in /Library/Breeze/bin/breeze-agent /usr/local/bin/breeze-agent; do
    if [ -x "$_breeze_bin" ] && "$_breeze_bin" containment release-all --reason uninstall; then
      return 0
    fi
  done
  # A broken or half-upgraded agent: the separately installed recovery binary
  # can release on its own.
  for _breeze_bin in /Library/Breeze/isolation-recovery/*/breeze-isolation-recovery; do
    if [ -x "$_breeze_bin" ] && "$_breeze_bin" release-all --data-dir "$_breeze_data" --reason uninstall; then
      return 0
    fi
  done
  echo "Error: could not confirm that network isolation was released; nothing was uninstalled." >&2
  echo "Release it from the console, or locally with 'sudo breeze-agent containment release', then retry." >&2
  return 1
}

# breeze_remove_isolation removes the recovery jobs and executables. Run only
# after breeze_release_isolation succeeded.
breeze_remove_isolation() {
  for _breeze_label in com.breeze.isolation.rollback com.breeze.isolation.expire com.breeze.isolation; do
    breeze_bootout "system/$_breeze_label" || return 1
  done
  rm -f /Library/LaunchDaemons/com.breeze.isolation.rollback.plist /Library/LaunchDaemons/com.breeze.isolation.expire.plist /Library/LaunchDaemons/com.breeze.isolation.plist || return 1
  rm -rf /Library/Breeze/isolation-recovery || return 1
}
# END BREEZE MACOS ISOLATION FUNCTIONS
