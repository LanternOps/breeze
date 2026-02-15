//go:build darwin

package mgmtdetect

import "os"

func (d *checkDispatcher) checkRegistryValue(_ string) bool {
	return false // not applicable on macOS
}

func (d *checkDispatcher) checkLaunchDaemon(label string) bool {
	paths := []string{
		"/Library/LaunchDaemons/" + label + ".plist",
		"/Library/LaunchAgents/" + label + ".plist",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}
