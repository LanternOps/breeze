//go:build !windows

package backup

import (
	"os"
	"syscall"
)

// fileOwner returns the Unix uid/gid of info, or nil when unavailable.
func fileOwner(info os.FileInfo) *FileOwner {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return &FileOwner{UID: int(st.Uid), GID: int(st.Gid)}
}

// restoreCanApplyOwnership reports whether chown/setuid will succeed.
func restoreCanApplyOwnership() bool { return os.Geteuid() == 0 }

func applyOwner(path string, owner *FileOwner) error {
	if owner == nil {
		return nil
	}
	return os.Lchown(path, owner.UID, owner.GID)
}
