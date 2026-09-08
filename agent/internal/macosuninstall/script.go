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

// Script preserves configuration, matching the service CLI's existing policy.
func Script() string {
	return Functions + `
breeze_stop_watchdog || exit 1
breeze_stop_helpers || exit 1
breeze_bootout system/com.breeze.agent || exit 1
rm -f /Library/LaunchDaemons/com.breeze.agent.plist /usr/local/bin/breeze-agent || exit 1
breeze_remove_auxiliary || exit 1
`
}
