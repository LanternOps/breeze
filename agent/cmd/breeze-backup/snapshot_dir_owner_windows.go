//go:build windows

package main

import (
	"os"

	"github.com/breeze-rmm/agent/internal/backup"
)

// fileOwner: the snapshot-dir command is Linux-only in practice (it feeds
// the QEMU recovery-media e2e, which builds a Linux root), but this file
// exists so `GOOS=windows go build ./cmd/breeze-backup/` — part of the
// normal cross-platform build check — keeps working.
func fileOwner(fi os.FileInfo) *backup.FileOwner {
	return nil
}
