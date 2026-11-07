// Package macosuninstall holds the package-owned teardown shared by local and
// detached macOS uninstall paths. Its shell source is embedded, never read from
// a mutable installation manifest on the endpoint.
package macosuninstall

import _ "embed"

// Functions stops only jobs and removes artifacts owned by the main agent pkg.
// Config, logs, the breeze group and the separately installed Assist are excluded.
//
//go:embed functions.sh
var Functions string

// IsolationFunctions releases network isolation and removes its recovery jobs.
// It is separate from Functions because Functions is also copied verbatim into
// the distributed uninstall.sh, which does not carry this file.
//
//go:embed isolation.sh
var IsolationFunctions string

// Script preserves configuration, matching the service CLI's existing policy.
// Isolation is released first: nothing below runs unless that is confirmed. It
// is confirmed again once the agent has stopped, because until then the agent
// can isolate the Mac again, and only then do the recovery jobs go.
func Script() string {
	return Functions + IsolationFunctions + `
breeze_release_isolation || exit 1
breeze_stop_watchdog || exit 1
breeze_stop_helpers || exit 1
breeze_bootout system/com.breeze.agent || exit 1
if ! breeze_release_isolation || ! breeze_remove_isolation; then
  breeze_restart_agent com.breeze.agent /Library/LaunchDaemons/com.breeze.agent.plist
  exit 1
fi
rm -f /Library/LaunchDaemons/com.breeze.agent.plist /usr/local/bin/breeze-agent /Library/Breeze/bin/breeze-agent || exit 1
breeze_remove_auxiliary || exit 1
`
}
