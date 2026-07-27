//go:build !windows

package main

import "os"

// hasConsole reports whether stdout is connected to a terminal. False when the
// helper is spawned by the agent running as a launchd daemon or systemd
// service, which is the normal case — the agent passes its own stdio down
// (sessionbroker/backup.go), and under a service manager that is not a
// terminal. Mirrors agentapp.hasConsole, which is unexported.
func hasConsole() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// redirectStderr points stderr at the log file so Go panic stack traces land
// there instead of being lost. On Unix the agent's inherited stderr is usually
// captured by the service manager's journal, so this is belt-and-braces.
func redirectStderr(f *os.File) {
	os.Stderr = f
}
