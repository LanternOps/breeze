//go:build linux

package helper

import (
	"os"
	"path/filepath"
	"strconv"
)

func processExePath(pid int) (string, error) {
	return os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
}

func isOurProcess(pid int, binaryPath string) bool {
	if pid <= 0 {
		return false
	}
	exePath, err := processExePath(pid)
	if err != nil {
		return false
	}
	return filepath.Clean(exePath) == filepath.Clean(binaryPath)
}

// isHelperRunningInSession scans the process table for the helper binary.
// The PID-tracked check in the watcher fails when:
//   - the helper was spawned via IPC (PID returned as 0)
//   - helper_status.yaml hasn't been written yet (helper still booting)
// In those windows the watcher would respawn even though a helper is alive,
// piling up orphaned processes. Session arg is ignored — Linux is single-
// session from the agent's perspective.
func isHelperRunningInSession(_ string, binaryPath string) bool {
	if binaryPath == "" {
		return false
	}
	return runHelperCommand("pgrep", "-f", binaryPath) == nil
}
