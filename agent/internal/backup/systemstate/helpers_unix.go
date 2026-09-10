//go:build !windows

package systemstate

import (
	"log/slog"
	"os"
	"syscall"
)

// lchownBestEffort applies info's owning uid/gid (as captured by os.Lstat,
// which does NOT follow symlinks) to path via os.Lchown — Lchown rather than
// Chown so a copied symlink's own ownership is set, never the ownership of
// whatever it points at. Best-effort: running unprivileged (no CAP_CHOWN) is
// a routine, expected way for this to fail — warn and move on rather than
// failing the whole collection over one file's ownership.
func lchownBestEffort(path string, info os.FileInfo) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	if err := os.Lchown(path, int(stat.Uid), int(stat.Gid)); err != nil {
		slog.Warn("systemstate: chown failed on staged copy, keeping the collecting process's owner",
			"path", path, "error", err.Error())
	}
}
