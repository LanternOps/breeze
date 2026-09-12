//go:build !windows

package main

import (
	"os"
	"syscall"

	"github.com/breeze-rmm/agent/internal/backup"
)

// fileOwner extracts the Unix uid/gid backing fi, or nil if unavailable
// (should not happen on a real Unix filesystem, but fails soft — an owner
// is nice-to-have for the e2e's synthetic snapshot, not load-bearing).
func fileOwner(fi os.FileInfo) *backup.FileOwner {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return &backup.FileOwner{UID: int(st.Uid), GID: int(st.Gid)}
}
