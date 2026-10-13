//go:build !windows

package watchdoginstall

import (
	"os"

	"golang.org/x/sys/unix"
)

func openLockFile(p string) (*os.File, error) {
	// O_NOFOLLOW: the Lstat check in AcquireLock is not atomic with the open.
	return os.OpenFile(p, os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW, 0o600)
}

func lockFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func unlockFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
