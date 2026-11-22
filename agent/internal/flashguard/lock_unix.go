//go:build darwin || linux

package flashguard

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func tryLock(f *os.File, mode lockMode) error {
	how := unix.LOCK_SH
	if mode == lockExclusive {
		how = unix.LOCK_EX
	}
	for {
		err := unix.Flock(int(f.Fd()), how|unix.LOCK_NB)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, unix.EINTR):
			continue
		case errors.Is(err, unix.EWOULDBLOCK):
			return errLockBusy
		default:
			return err
		}
	}
}
