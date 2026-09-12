//go:build windows

package backup

import "os"

// fileOwner is a no-op on Windows: SnapshotFile.Owner stays nil there.
func fileOwner(_ os.FileInfo) *FileOwner { return nil }

// restoreCanApplyOwnership is always false on Windows (no Unix chown).
func restoreCanApplyOwnership() bool { return false }

func applyOwner(_ string, _ *FileOwner) error { return nil }
