//go:build darwin

package helper

import (
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func processExePath(pid int) (string, error) {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
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
