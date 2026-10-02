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
// tightens it to 0700. The checks and the chmod go through one descriptor
// opened with O_NOFOLLOW|O_DIRECTORY, so a symlink swapped in after the
// mkdir (a shared /tmp on Linux) is refused rather than followed. See
// user_workspace.go.
func secureUserWorkspaceDir(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("create workspace %s: %w", path, err)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
			return fmt.Errorf("refuse workspace %s: not a real directory (symlink or file): %w", path, err)
		}
		return fmt.Errorf("open workspace %s: %w", path, err)
	}
	defer func() { _ = syscall.Close(fd) }()

	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return fmt.Errorf("inspect workspace %s: %w", path, err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return fmt.Errorf("refuse non-directory workspace %s", path)
	}
	if int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("refuse workspace %s owned by uid %d, not this process (uid %d)", path, st.Uid, os.Geteuid())
	}
	if err := syscall.Fchmod(fd, 0o700); err != nil {
		return fmt.Errorf("secure workspace %s: %w", path, err)
	}
	return nil
}

// workspaceOwnerSID is Windows-only: off Windows the ProgramData trust check
// reads no owners, so there is no extra principal to accept.
func workspaceOwnerSID() string { return "" }
