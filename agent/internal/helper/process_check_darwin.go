//go:build darwin

package helper

import (
	"path/filepath"
	"strconv"
)

func processExePath(pid int) (string, error) {
	out, err := outputHelperCommand("ps", "-o", "comm=", "-p", strconv.Itoa(pid))
	if err != nil {
		return "", err
	}
	return parseProcessPathOutput(out)
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

// isHelperRunningInSession is a no-op on macOS (session-based spawning is
// Windows-only). The PID-based check is sufficient on macOS/Linux.
func isHelperRunningInSession(_ string, _ string) bool {
	return false
}
