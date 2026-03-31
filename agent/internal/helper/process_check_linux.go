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
