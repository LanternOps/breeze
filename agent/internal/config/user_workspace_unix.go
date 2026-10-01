//go:build !windows

package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// secureUserWorkspaceDir creates path 0700, or verifies an existing one is a
// real directory (not a symlink) owned by this process's effective uid and
// tightens it to 0700. See user_workspace.go.
func secureUserWorkspaceDir(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("create workspace %s: %w", path, err)
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect workspace %s: %w", path, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refuse symlinked workspace %s", path)
	}
	if !fi.IsDir() {
		return fmt.Errorf("refuse non-directory workspace %s", path)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("refuse workspace %s owned by uid %d, not this process (uid %d)", path, st.Uid, os.Geteuid())
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("secure workspace %s: %w", path, err)
	}
	return nil
}
