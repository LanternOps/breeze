//go:build !windows

package backup

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockJournalFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func unlockJournalFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
