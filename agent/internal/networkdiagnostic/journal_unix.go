//go:build !windows

package networkdiagnostic

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

func replaceJournal(from, to string) error {
	if e := os.Rename(from, to); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(to))
	if e != nil {
		return e
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}

func lockJournal(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}
