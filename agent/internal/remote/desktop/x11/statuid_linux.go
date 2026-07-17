//go:build linux

package x11

import (
	"io/fs"
	"os/user"
	"strconv"
	"syscall"
)

func statUID(fi fs.FileInfo) int {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid)
	}
	return 0
}

func lookupUsername(uid int) string {
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		return u.Username
	}
	return ""
}
