//go:build !windows

package watchdog

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

// isAliveWindows is a no-op stub on non-Windows platforms. IsAlive on Unix
// uses signal(0) directly and never falls through to this function.
func isAliveWindows(_ int) bool { return false }

// IsAlive reports whether the process is running by sending signal 0.
func (c *OSProcessChecker) IsAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// IsZombie reports whether the process is a zombie.
// On Linux, reads /proc/<pid>/status; on macOS always returns false.
func (c *OSProcessChecker) IsZombie(pid int) bool {
	path := fmt.Sprintf("/proc/%d/status", pid)
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range splitLines(data) {
		if strings.HasPrefix(line, "State:") && len(line) > 6 {
			// Skip whitespace (tab or space) after "State:"
			for i := 6; i < len(line); i++ {
				if line[i] != ' ' && line[i] != '\t' {
					return line[i] == 'Z'
				}
			}
		}
	}
	return false
}

// splitLines splits a byte slice on newlines.
func splitLines(data []byte) []string {
	var lines []string
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, string(data[start:i]))
			start = i + 1
		}
	}
	if start < len(data) {
		lines = append(lines, string(data[start:]))
	}
	return lines
}
