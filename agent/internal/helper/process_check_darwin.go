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
