//go:build darwin

package tools

import (
	"bytes"

	"golang.org/x/sys/unix"
)

// readMountTable lists the mount points (f_mntonname) of every mounted
// filesystem.
func readMountTable() ([]string, bool) {
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil || n <= 0 {
		return nil, false
	}
	buf := make([]unix.Statfs_t, n+8)
	n, err = unix.Getfsstat(buf, unix.MNT_NOWAIT)
	if err != nil || n <= 0 {
		return nil, false
	}
	table := make([]string, 0, n)
	for _, st := range buf[:n] {
		name := st.Mntonname[:]
		if i := bytes.IndexByte(name, 0); i >= 0 {
			name = name[:i]
		}
		if len(name) > 0 {
			table = append(table, string(name))
		}
	}
	return table, len(table) > 0
}
