//go:build darwin

package watchdoginstall

import "github.com/breeze-rmm/agent/internal/securefs"

// darwinWatchdogPlist is the LaunchDaemon `breeze-watchdog service install`
// writes.
const darwinWatchdogPlist = "/Library/LaunchDaemons/com.breeze.watchdog.plist"

// Detect reports whether the watchdog is registered: the binary in the trusted
// executable dir (or, on a host not yet migrated, the legacy dir — mirroring
// heartbeat.watchdogBinaryPath) and its LaunchDaemon plist.
func Detect(stat StatFunc) Status {
	return detectFiles(stat, "", []string{
		securefs.TrustedExecutableDir + "/breeze-watchdog",
		securefs.LegacyExecutableDir + "/breeze-watchdog",
	}, darwinWatchdogPlist)
}
