//go:build !windows

package main

import "fmt"

// isWindowsService always returns false on non-Windows platforms.
func isWindowsService() bool { return false }

// hasConsole returns true on non-Windows platforms (always have a TTY or pipe).
func hasConsole() bool { return true }

// runAsService is a no-op stub on non-Windows platforms.
func runAsService(_ func() (*agentComponents, error)) error {
	return fmt.Errorf("Windows service mode is not available on this platform")
}
