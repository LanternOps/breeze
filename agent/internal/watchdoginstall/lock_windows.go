//go:build windows

package watchdoginstall

import (
	"os"

	"golang.org/x/sys/windows"
)

func openLockFile(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0o600)
}

func lockFile(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &windows.Overlapped{})
}
