//go:build !windows

package watchdoginstall

import (
	"fmt"
	"os"
	"syscall"
)

// checkStageRootOwner refuses a stage root owned by another user: the verified
// artifact is executed as root from inside it.
func checkStageRootOwner(fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("watchdog stage root owner cannot be determined")
	}
	if int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("watchdog stage root is owned by uid %d, not %d", st.Uid, os.Geteuid())
	}
	return nil
}
