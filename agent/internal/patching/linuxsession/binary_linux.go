//go:build linux

package linuxsession

import (
	"io/fs"
	"syscall"
)

func init() {
	binaryOwnershipOK = rootOwnedAndNotGroupOrWorldWritable
}

// rootOwnedAndNotGroupOrWorldWritable rejects a resolved binary that a non-root
// account could have replaced.
//
// The fixed search directories are root-owned on any sane system, but "on any
// sane system" is exactly the assumption worth checking rather than asserting:
// a /usr/local/bin left group-writable by a careless install, or a binary
// chowned to a service account, would let a local user choose what the daemon
// executes — and the zenity it chooses is the thing that reports whether the
// user postponed their reboot.
func rootOwnedAndNotGroupOrWorldWritable(info fs.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		// Unknown stat shape. Refuse rather than assume: this only ever runs on
		// Linux, where the assertion holds.
		return false
	}
	if st.Uid != 0 {
		return false
	}
	return info.Mode().Perm()&0o022 == 0
}
