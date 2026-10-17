package main

import (
	"os"
	"path/filepath"
)

// installedAgentPath returns the agent binary the macOS .pkg installed. The
// package puts it in trustedDir (/Library/Breeze/bin) or legacyDir
// (/usr/local/bin) by the rules in agent/installer/macos/install-location.sh
// (#7211): an agent already in trustedDir stays there, so it wins over a
// leftover pre-relocation legacy copy. Anything else falls back to the legacy
// path, which is what the watchdog always used before (#8778).
func installedAgentPath(trustedDir, legacyDir string) string {
	trusted := filepath.Join(trustedDir, "breeze-agent")
	if fi, err := os.Lstat(trusted); err == nil && fi.Mode().IsRegular() {
		return trusted
	}
	return filepath.Join(legacyDir, "breeze-agent")
}
