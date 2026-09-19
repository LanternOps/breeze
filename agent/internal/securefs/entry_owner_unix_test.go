//go:build linux || darwin

package securefs

import (
	"os"
	"syscall"
)

func fileUID(info os.FileInfo) int {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return -1
	}
	return int(st.Uid)
}
