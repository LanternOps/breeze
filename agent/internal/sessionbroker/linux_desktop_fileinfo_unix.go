//go:build !windows

package sessionbroker

import (
	"io/fs"
	"os"
	"syscall"
)

// fileIdentity returns the device, inode and owner uid of fi.
func fileIdentity(fi fs.FileInfo) (dev, ino uint64, uid uint32, ok bool) {
	st, isStat := fi.Sys().(*syscall.Stat_t)
	if !isStat {
		return 0, 0, 0, false
	}
	return uint64(st.Dev), uint64(st.Ino), st.Uid, true //nolint:unconvert // Dev is int32 on darwin
}

// defaultLinuxDesktopChown gives a per-uid endpoint to its uid, group root.
func defaultLinuxDesktopChown(path string, uid uint32) error {
	return os.Chown(path, int(uid), 0)
}
