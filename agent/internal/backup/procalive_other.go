//go:build !windows

package backup

import (
	"errors"
	"os"
	"syscall"
)

// processAlive reports whether a process with pid exists. A process owned by
// another user answers EPERM, which still means it exists.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
