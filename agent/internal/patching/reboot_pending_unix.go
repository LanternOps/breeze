//go:build unix

package patching

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// trustPendingRecordFile refuses a pending-restart record that another
// account could have written, replaced or removed. The agent runs as root and
// writes the record 0600 inside its data dir. A record that is a link,
// writable by group or others, or owned by another user, or one in a
// directory other accounts can write (where they could swap or delete it),
// was not left there by the agent alone: acting on it would let a local user
// schedule a restart, and trusting the directory would let them cancel one.
func trustPendingRecordFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file (mode %s)", info.Mode())
	}
	if err := ownedAndPrivate(info, 0o022); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	dirPath := filepath.Dir(path)
	dir, err := os.Stat(dirPath)
	if err != nil {
		return err
	}
	// World write only for the directory, as config.reclaimUnixDir judges the
	// agent's own folders: the installers grant group write to some of them
	// for the user-context helpers, and the group is root's choice.
	if err := ownedAndPrivate(dir, 0o002); err != nil {
		return fmt.Errorf("directory %s: %w", dirPath, err)
	}
	return nil
}

// ownedAndPrivate requires info to be owned by this process's user and to
// carry none of the forbidden permission bits.
func ownedAndPrivate(info os.FileInfo, forbidden os.FileMode) error {
	if perm := info.Mode().Perm(); perm&forbidden != 0 {
		return fmt.Errorf("writable by other accounts (mode %o)", perm)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("owner unavailable")
	}
	if euid := os.Geteuid(); int(st.Uid) != euid {
		return fmt.Errorf("owned by uid %d, not %d", st.Uid, euid)
	}
	return nil
}
