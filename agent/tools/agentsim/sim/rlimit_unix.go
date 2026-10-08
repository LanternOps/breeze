//go:build linux || darwin

package sim

import (
	"fmt"
	"syscall"
)

// checkFileLimit makes sure the process may hold one HTTP and one WebSocket
// socket per agent plus headroom. macOS defaults to 256 open files.
func checkFileLimit(agents int) error {
	need := uint64(agents)*2 + 256
	var lim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err != nil {
		return nil // cannot tell; let the run surface EMFILE itself
	}
	if lim.Cur >= need {
		return nil
	}
	raised := lim
	raised.Cur = need
	if raised.Max < need {
		raised.Cur = raised.Max
	}
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &raised)
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err == nil && lim.Cur >= need {
		return nil
	}
	return fmt.Errorf("open-file limit %d is below the %d this run needs (two sockets per agent); run `ulimit -n %d` first", lim.Cur, need, need)
}
