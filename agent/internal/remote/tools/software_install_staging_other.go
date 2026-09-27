//go:build !windows

package tools

import "os"

// createPrivateInstallDir returns a fresh 0700 directory created atomically
// by the OS. On macOS and Linux the agent-owned parent temp directory is
// already private by default, so os.MkdirTemp's own 0700 mode is sufficient
// here; the hardened Windows path lives in software_install_staging_windows.go.
func createPrivateInstallDir() (string, error) {
	return os.MkdirTemp("", "breeze-sw-install-*")
}
