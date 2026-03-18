//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
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

// isHeadless returns true when the process has no controlling terminal.
// This is the case for launchd daemons and systemd services — both of which
// redirect stdout/stderr to log files, leaving no character device.
func isHeadless() bool { return !hasConsole() }

// redirectStderr points fd 2 at the given file so that Go runtime panics
// are captured in the log file.
func redirectStderr(f *os.File) {
	syscall.Dup2(int(f.Fd()), 2)
}

// runAsService is a no-op stub on non-Windows platforms.
func runAsService(_ func() (*agentComponents, error)) error {
	return fmt.Errorf("Windows service mode is not available on this platform")
}

// ensureSASPolicy is a no-op on non-Windows platforms.
func ensureSASPolicy() {}
