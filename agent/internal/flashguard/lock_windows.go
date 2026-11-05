//go:build windows

package flashguard

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func tryLock(f *os.File, mode lockMode) error {
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if mode == lockExclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	var overlapped windows.Overlapped
	err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &overlapped)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, windows.ERROR_LOCK_VIOLATION), errors.Is(err, windows.ERROR_IO_PENDING):
		return errLockBusy
	default:
		return err
	}
}
