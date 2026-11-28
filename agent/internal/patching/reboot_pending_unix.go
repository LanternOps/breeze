//go:build unix

package patching

import (
	"fmt"
	"os"
	"syscall"
)

// trustPendingRecordFile refuses a pending-restart record anyone but this
// process's user could have written. The agent runs as root and writes the
// record 0600 inside a 0700 data dir; a record that is a link, writable by
// group or others, or owned by another user was not left there by it, and
// acting on it would let a local user schedule — or by deleting it, cancel —
// a restart.
func trustPendingRecordFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file (mode %s)", info.Mode())
	}
	if perm := info.Mode().Perm(); perm&0o022 != 0 {
		return fmt.Errorf("writable by group or others (mode %o)", perm)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("file owner unavailable")
	}
	if euid := os.Geteuid(); int(st.Uid) != euid {
		return fmt.Errorf("owned by uid %d, not %d", st.Uid, euid)
	}
	return nil
}
