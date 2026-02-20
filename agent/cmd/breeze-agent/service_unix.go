//go:build !windows

package main

import (
	"fmt"
	"os"
)

// isWindowsService always returns false on non-Windows platforms.
func isWindowsService() bool { return false }

// hasConsole reports whether stdout is connected to a terminal.
// Returns false when running as a launchd daemon or systemd service.
func hasConsole() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// runAsService is a no-op stub on non-Windows platforms.
func runAsService(_ func() (*agentComponents, error)) error {
	return fmt.Errorf("Windows service mode is not available on this platform")
}

// ensureSASPolicy is a no-op on non-Windows platforms.
func ensureSASPolicy() {}
